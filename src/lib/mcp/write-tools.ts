import { z } from "zod";
import { prisma } from "@/lib/db";
import { canOperateProject, isAnyAdmin, type Actor } from "@/lib/authz";
import { defaultKey } from "@/lib/export/defaults";
import { saveProductAttributes } from "@/lib/export/product-attributes";
import {
  categoryIndex,
  resolveAssignments,
  type ProposedAssignment,
} from "@/lib/categorize/taxonomy";
import { isUnresolvedSkuOnly } from "@/lib/ai/resolve-sku";
import { flags } from "@/lib/flags";
import { RUNS_PER_DAY, invokeAsUser, runQuotaRemaining } from "./invoke";
import { hashSecret, newSecret } from "@/lib/oauth/core";
import { baseUrl } from "@/lib/oauth/metadata";
import { toTileId } from "@/lib/marketplaces/catalog";

/** Long enough to find the file and run the command; short enough that a
 *  link left in a log is not a standing invitation. */
const UPLOAD_TICKET_TTL_MS = 30 * 60 * 1000;
import { vendorCategoryOf, type McpTool, type ToolResult } from "./tools";

/**
 * Tools that change things, off for each person until they switch them on.
 *
 * Letting a language model edit a live catalogue is a decision a person makes
 * deliberately, having read what these do — not one that arrives with a
 * deploy. So each account starts read-only, a tool is not even listed until
 * its owner has chosen it on Settings → Connect to Claude, MCP_WRITE_ENABLED
 * can still switch all of them off at once, and each of them is built to be
 * reversible or to refuse.
 *
 * Three rules hold throughout:
 *
 *   1. Nothing here can do what the web app forbids. canOperateProject is
 *      owner-only â€” an admin may LOOK at someone's project but not start runs
 *      or edit rows in it, and that is enforced by the same function the UI
 *      calls, not a copy of its intent.
 *
 *   2. Every bulk change previews by default. `apply: true` is required to
 *      write, so "set the category for everything matching X" answers with
 *      what it WOULD touch until somebody confirms. A model that
 *      misunderstands a filter then costs a sentence, not a catalogue.
 *
 *   3. A change is capped. Beyond MAX_WRITE rows the tool refuses and says to
 *      narrow the filter â€” an instruction that would rewrite 60,000 products
 *      is more likely a mistake than a plan.
 */

const MAX_WRITE = 500;

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

export const WRITE_TOOLS: McpTool[] = [
  {
    name: "run_categorization",
    title: "Run Mercato's categorisation",
    description:
      "Start (or continue) Mercato's own categorisation on a project â€” the same run the Categorize button starts, " +
      "with the same taxonomy, reuse and confidence. Long runs come back with done=false and a resumeFrom; call " +
      "again with it until done. Only projects you own. Spends Mercato's AI balance.",
    schema: {
      projectId: z.string(),
      force: z.boolean().optional().describe("Re-categorise everything, not just uncategorised rows"),
      resumeFrom: z.number().optional().describe("Echo back from a previous partial result"),
    },
    async run(actor: Actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only run categorisation on projects you own." });
      }

      // Only the first call of a logical run counts against the quota â€”
      // continuing one somebody already started is finishing work, not
      // starting new spend, and refusing halfway would strand the project.
      if (a.resumeFrom == null) {
        const left = await runQuotaRemaining(actor.id, ["run_categorization"]);
        if (left <= 0) {
          return ok({
            error: `You have started ${RUNS_PER_DAY} runs in the last 24 hours, which is the limit. ` +
              "Run it from Mercato directly if this is deliberate.",
          });
        }
      }

      // Mercato's own endpoint, called the way the browser calls it â€” so the
      // spend guard, the taxonomy, the reuse cache and the resume logic are
      // the ones already in use, not a second copy.
      const res = await invokeAsUser(actor.id, `/api/projects/${encodeURIComponent(id)}/categorize`, {
        method: "POST",
        body: { force: a.force === true, ...(a.resumeFrom != null ? { resumeFrom: a.resumeFrom } : {}) },
      });

      if (!res.ok) {
        const b = res.body as { error?: string; code?: string };
        return ok({
          error: b?.error ?? `Mercato refused the run (HTTP ${res.status})`,
          ...(b?.code === "AI_BUDGET_LOW" ? { hint: "Top up the Kimi balance and try again." } : {}),
        });
      }

      const b = res.body as { partial?: boolean; resumeFrom?: number; [k: string]: unknown };
      const remaining = await prisma.product.count({
        where: { projectId: id, OR: [{ marketplaceCategory: null }, { marketplaceCategory: "Uncategorized" }] },
      });
      return ok({
        ...b,
        done: b?.partial !== true,
        stillUncategorised: remaining,
        note:
          b?.partial === true
            ? "The run hit its time budget. Call again with the resumeFrom above to continue."
            : "Finished. Check export_readiness before exporting.",
      });
    },
  },

  {
    name: "create_project_upload",
    title: "Start a project and get somewhere to send the file",
    description:
      "Issue a one-time link for uploading a vendor spreadsheet. The project is created from the file when it " +
      "arrives, by Mercato, exactly as the New Project button does. Use this instead of asking the person to " +
      "go and do it — if you can reach the file, upload it yourself with the command returned.",
    schema: {
      name: z.string().describe("What to call the project"),
      marketplace: z.string().describe("mathis, walmart, bestbuy, amazon_us, temu, sears"),
      isNewListing: z
        .boolean()
        .optional()
        .describe("Walmart only: a new listing, with no live page to verify against"),
    },
    async run(actor: Actor, a) {
      const name = String(a.name ?? "").trim();
      const marketplace = String(a.marketplace ?? "").trim().toLowerCase();
      if (!name) return ok({ error: "A project name is required" });
      if (!marketplace) return ok({ error: "A marketplace is required" });

      // The same allow-list the creation route enforces, checked here too so
      // the refusal arrives before somebody uploads a file for nothing.
      const account = await prisma.user.findUnique({
        where: { id: actor.id },
        select: { role: true, allowedMarketplaces: true },
      });
      if (!account) return ok({ error: "Account not found" });
      const allowed = isAnyAdmin(actor) || account.allowedMarketplaces.includes(toTileId(marketplace));
      if (!allowed) {
        return ok({ error: `You do not have access to create ${marketplace} projects.` });
      }

      const token = newSecret("mrc_u_");
      const expiresAt = new Date(Date.now() + UPLOAD_TICKET_TTL_MS);
      await prisma.uploadTicket.create({
        data: {
          tokenHash: hashSecret(token),
          userId: actor.id,
          name,
          marketplace,
          isNewListing: a.isNewListing === true && marketplace === "walmart",
          expiresAt,
        },
      });

      const base = await baseUrl();
      const uploadUrl = `${base}/api/projects/upload?t=${token}`;
      return ok({
        uploadUrl,
        expiresAt,
        project: { name, marketplace },
        // A ready-to-run command, because the useful version of this is
        // Claude uploading the file itself rather than reading the URL out
        // to somebody. The bytes go from the machine holding them straight
        // to Mercato and never through the conversation.
        curl: `curl -F "file=@/path/to/your-file.xlsx" "${uploadUrl}"`,
        note:
          "Single use, and it expires. Replace the path and run it where the spreadsheet is — the project " +
          "is created from the file when it arrives. Treat the link as a password: it creates a project as you.",
      });
    },
  },

  {
    name: "submit_export_values",
    title: "Fill required cells the export left empty",
    description:
      "Store values for required template columns, from next_export_gaps. They go into the same place " +
      "Mercato's own AI fills write to, so the next export uses them WITHOUT calling any model. Only " +
      "projects you own.",
    schema: {
      projectId: z.string(),
      values: z
        .array(
          z.object({
            productId: z.string(),
            column: z.string().describe("Exactly as next_export_gaps named it, e.g. Material"),
            value: z.string().describe("Answer from the product's own data â€” omit the entry if it does not state one"),
          }),
        )
        .describe("One entry per product and column"),
    },
    async run(actor: Actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only change projects you own." });
      }

      const rows = Array.isArray(a.values) ? (a.values as { productId: string; column: string; value: string }[]) : [];
      if (!rows.length) return ok({ error: "No values given" });
      if (rows.length > MAX_WRITE) {
        return ok({ error: `${rows.length} values, over the ${MAX_WRITE} limit. Send smaller batches.` });
      }

      // Every id must belong to THIS project â€” the same check every other
      // write here makes, for the same reason.
      const mine = new Set(
        (
          await prisma.product.findMany({
            where: { projectId: id, id: { in: [...new Set(rows.map((r) => String(r.productId)))] } },
            select: { id: true },
          })
        ).map((p) => p.id),
      );

      const accepted: { productId: string; attribute: string; value: string; source: "ai" }[] = [];
      const rejected: { productId: string; column: string; reason: string }[] = [];
      for (const r of rows) {
        const productId = String(r.productId ?? "").trim();
        const column = String(r.column ?? "").trim();
        const value = String(r.value ?? "").trim();
        if (!mine.has(productId)) {
          rejected.push({ productId, column, reason: "Not a product of this project" });
          continue;
        }
        if (!column) { rejected.push({ productId, column, reason: "No column named" }); continue; }
        // An empty value is not a fill, it is a gap â€” and writing one would
        // mark the cell answered while leaving it blank, which is worse than
        // leaving it visibly missing.
        if (!value) { rejected.push({ productId, column, reason: "Empty value â€” leave the entry out instead" }); continue; }
        accepted.push({ productId, attribute: column, value, source: "ai" });
      }

      // The same store the catalog lookup and the AI fill write to, keyed the
      // same way, so the export reads these exactly as it reads its own.
      const saved = accepted.length ? await saveProductAttributes(accepted) : 0;

      return ok({
        saved,
        rejected,
        note:
          saved > 0
            ? "Stored. The next export fills these cells from here â€” no AI call, so they work with no credit at all."
            : "Nothing stored.",
      });
    },
  },

  {
    name: "run_verification",
    title: "Run Mercato's verification",
    description:
      "Start Mercato's own verification on a project â€” fetches each product's live marketplace listing and " +
      "compares title, images, description and dimensions. The same run the Verify button starts. Long runs " +
      "come back partial; call again to continue. Only projects you own. Spends Mercato's AI and lookup credit.",
    schema: { projectId: z.string() },
    async run(actor: Actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only verify projects you own." });
      }

      // Verification is the most expensive thing Mercato does â€” measured at
      // 92% of all AI tokens spent â€” so the ceiling matters more here than
      // anywhere else.
      const left = await runQuotaRemaining(actor.id, ["run_verification"]);
      if (left <= 0) {
        return ok({ error: `You have started ${RUNS_PER_DAY} verifications in the last 24 hours, which is the limit.` });
      }

      const res = await invokeAsUser(actor.id, `/api/projects/${encodeURIComponent(id)}/verify`, {
        method: "POST",
      });
      if (!res.ok) {
        const b = res.body as { error?: string };
        return ok({ error: b?.error ?? `Mercato refused the run (HTTP ${res.status})` });
      }
      return ok({
        ...(res.body as object),
        note: "Use job_status to follow it, then verification_issues to see what it flagged.",
      });
    },
  },

  {
    name: "reverify_product",
    title: "Re-check one product",
    description:
      "Re-fetch one product's live listing and compare again â€” for a single row whose verdict looks wrong. " +
      "Only projects you own.",
    schema: {
      projectId: z.string(),
      productId: z.string().describe("From find_products or verification_issues"),
    },
    async run(actor: Actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only change projects you own." });
      }
      // One product of THIS project â€” the same check submit_categorization
      // makes, for the same reason.
      const owned = await prisma.product.findFirst({
        where: { id: String(a.productId), projectId: id },
        select: { id: true },
      });
      if (!owned) return ok({ error: "Not a product of this project" });

      const res = await invokeAsUser(actor.id, `/api/projects/${encodeURIComponent(id)}/verify/product`, {
        method: "POST",
        body: { productId: String(a.productId) },
      });
      if (!res.ok) {
        const b = res.body as { error?: string };
        return ok({ error: b?.error ?? `Mercato refused it (HTTP ${res.status})` });
      }
      return ok(res.body);
    },
  },

  {
    name: "run_export",
    title: "Run Mercato's export",
    description:
      "Start (or continue) Mercato's own export â€” the same one the Export button starts, filling your uploaded " +
      "templates. A large catalogue comes back with done=false; call again with the jobId until done, then " +
      "download it from Mercato. Only projects you own.",
    schema: {
      projectId: z.string(),
      jobId: z.string().optional().describe("Echo back from a previous partial result to continue"),
      autoMatch: z.boolean().optional().describe("Match each category to its closest template (default true)"),
    },
    async run(actor: Actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only export projects you own." });
      }

      if (!a.jobId) {
        const left = await runQuotaRemaining(actor.id, ["run_export"]);
        if (left <= 0) {
          return ok({ error: `You have started ${RUNS_PER_DAY} exports in the last 24 hours, which is the limit.` });
        }
      }

      // The export is already built one slice per request â€” the browser
      // drives exactly this loop. Claude takes the same role, so the slicing,
      // the budget and the job store are the ones already in use.
      const qs = a.jobId ? `?jobId=${encodeURIComponent(String(a.jobId))}` : "";
      const res = await invokeAsUser(
        actor.id,
        `/api/projects/${encodeURIComponent(id)}/export${qs}`,
        { method: "POST", body: { autoMatch: a.autoMatch !== false } },
      );
      if (!res.ok) {
        const b = res.body as { error?: string };
        return ok({ error: b?.error ?? `Mercato refused the export (HTTP ${res.status})` });
      }

      const b = res.body as { jobId?: string; done?: boolean; remaining?: number; total?: number; mode?: string };
      const done = b?.mode === "background" ? undefined : b?.done === true;
      return ok({
        jobId: b?.jobId,
        mode: b?.mode,
        ...(b?.total != null ? { filesDone: (b.total ?? 0) - (b.remaining ?? 0), filesTotal: b.total } : {}),
        done,
        // The finished file is a spreadsheet, and a spreadsheet does not
        // belong in a conversation â€” base64 of a real catalogue is megabytes
        // of noise. Mercato serves it; this says where.
        note:
          done === false
            ? "Not finished. Call again with this jobId to build the next part."
            : "Open the project's Export step in Mercato to download it.",
      });
    },
  },

  {
    name: "submit_categorization",
    title: "Submit categories for a batch",
    description:
      "Write the categories chosen for a batch from next_categorization_batch. Every path is checked against the " +
      "marketplace's category list; anything not in it is refused and that product stays uncategorised. Only projects you own.",
    schema: {
      projectId: z.string(),
      assignments: z
        .array(
          z.object({
            productId: z.string(),
            category: z.string().describe("An EXACT path from the list the batch supplied"),
            confidence: z.number().optional().describe("0-1; low values stay flagged for review"),
          }),
        )
        .describe("One entry per product"),
    },
    async run(actor: Actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, marketplace: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only categorise projects you own." });
      }

      const proposals = Array.isArray(a.assignments) ? (a.assignments as ProposedAssignment[]) : [];
      if (!proposals.length) return ok({ error: "No assignments given" });
      if (proposals.length > MAX_WRITE) {
        return ok({ error: `${proposals.length} assignments, over the ${MAX_WRITE} limit. Send smaller batches.` });
      }

      // Without a list there is nothing to check against, and an unchecked
      // category is the failure this tool exists to prevent.
      const index = categoryIndex(project.marketplace);
      if (!index) {
        return ok({ error: `No category list for ${project.marketplace} â€” refusing to write unchecked categories.` });
      }

      const { accepted, rejected } = resolveAssignments(index, proposals);

      // Every id must belong to THIS project. Without it a product id from a
      // project the caller cannot even see could be written through a project
      // they own â€” the filter, not the id, is what authorisation rests on.
      const mine = accepted.length
        ? await prisma.product.findMany({
            where: { projectId: id, id: { in: accepted.map((x) => x.productId) } },
            select: { id: true, name: true, vendorSku: true, description: true, vendorData: true },
          })
        : [];
      const byId = new Map(mine.map((p) => [p.id, p]));

      // The same gate the batch applies, repeated here on purpose. The
      // categorise route does exactly this â€” skip before spending, refuse
      // again before trusting â€” because a caller that was told a row is
      // hopeless can still send a category for it, and a confident guess at
      // "VIDA-110112" passes every other check in this function.
      const writable: typeof accepted = [];
      for (const x of accepted) {
        const p = byId.get(x.productId);
        if (!p) {
          rejected.push({ productId: x.productId, category: x.category, reason: "Not a product of this project" });
          continue;
        }
        if (
          isUnresolvedSkuOnly({
            name: p.name,
            sku: p.vendorSku,
            description: p.description,
            vendorCategory: vendorCategoryOf(p.vendorData),
          })
        ) {
          rejected.push({
            productId: x.productId,
            category: x.category,
            reason:
              "Bare vendor code with no title, description or vendor category â€” nothing to classify from, " +
              "so this would be a guess. Run Categorize in Mercato to resolve it to a real title first.",
          });
          continue;
        }
        writable.push(x);
      }

      const now = new Date();
      let written = 0;
      for (const x of writable) {
        await prisma.product.update({
          where: { id: x.productId },
          // Both columns, as the batch categoriser writes them: the export
          // groups on marketplaceCategory and the UI reads categoryPath.
          data: {
            marketplaceCategory: x.category,
            categoryPath: x.category,
            categoryConfidence: x.confidence,
            categorizedAt: now,
          },
        });
        written++;
      }

      const remaining = await prisma.product.count({
        where: { projectId: id, OR: [{ marketplaceCategory: null }, { marketplaceCategory: "Uncategorized" }] },
      });

      // Leave the project looking exactly as Mercato's own run leaves it, so
      // opening the app after categorising here shows the same thing as
      // categorising there.
      //
      // Finished: status and categorizeCompletedAt together. The timestamp is
      // what the Categorize step reads to say the run is done — setting the
      // status alone left a project that said "categorized" with no
      // completion to show for it.
      //
      // Part-way: the status is deliberately NOT moved to "categorizing".
      // Mercato's own partial stop reverts it for a reason its code states —
      // "nothing is ever stuck categorizing if the client vanishes" — and a
      // conversation that stops halfway is exactly that client vanishing.
      // The per-product counts the screen shows come from the products
      // themselves and are already correct, so the work IS visible either
      // way; only the word is held back until it is true.
      if (written > 0) {
        await prisma.project
          .update({
            where: { id },
            data:
              remaining === 0
                ? { status: "categorized", categorizeCompletedAt: new Date() }
                : // Touch it so the project sorts as recently worked on and
                  // "last activity" is honest about what just happened.
                  { updatedAt: new Date() },
          })
          .catch(() => {});
      }

      return ok({
        written,
        rejected,
        remaining,
        note:
          remaining > 0
            ? "Call next_categorization_batch again for the rest. Rejected products are still uncategorised and will come back."
            : "Every product in this project now has a category.",
      });
    },
  },

  {
    name: "set_product_category",
    title: "Set a category",
    description:
      "Set the marketplace category on products in one project. Previews by default; pass apply=true to write. Only on projects you own.",
    schema: {
      projectId: z.string(),
      category: z.string().describe("The exact category path to set"),
      matchName: z.string().optional().describe("Only products whose name contains this"),
      onlyUncategorised: z.boolean().optional().describe("Only products with no category yet"),
      apply: z.boolean().optional().describe("false (default) previews; true writes"),
    },
    async run(actor: Actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      // Owner-only, exactly as in the browser: editing someone's catalogue
      // under their name is not something an admin should do by accident.
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only change projects you own." });
      }

      const where = {
        projectId: id,
        ...(a.matchName ? { name: { contains: String(a.matchName), mode: "insensitive" as const } } : {}),
        ...(a.onlyUncategorised
          ? { OR: [{ marketplaceCategory: null }, { marketplaceCategory: "Uncategorized" }] }
          : {}),
      };

      const count = await prisma.product.count({ where });
      if (count === 0) return ok({ matched: 0, note: "Nothing matched â€” no change made." });
      if (count > MAX_WRITE) {
        return ok({
          error: `${count} products matched, over the ${MAX_WRITE} limit. Narrow the filter.`,
          matched: count,
        });
      }

      const sample = await prisma.product.findMany({
        where,
        select: { name: true, vendorSku: true, marketplaceCategory: true },
        take: 10,
      });

      if (a.apply !== true) {
        return ok({
          preview: true,
          wouldChange: count,
          to: String(a.category),
          sample,
          note: "Nothing was written. Call again with apply=true to make this change.",
        });
      }

      const res = await prisma.product.updateMany({
        where,
        data: { marketplaceCategory: String(a.category) },
      });
      return ok({ changed: res.count, to: String(a.category), project: project.name });
    },
  },

  {
    name: "set_export_default",
    title: "Set an export default",
    description:
      "Set a fixed value for a required column no data source can answer â€” Proposition 65, PFAS, embedded battery. Applies to every export for that marketplace.",
    schema: {
      marketplace: z.string().describe("e.g. bestbuy, mathis"),
      attribute: z.string().describe("Column name or field code, e.g. californiaProposition65Warning.type"),
      value: z.string().describe("The value to write. Empty string clears it."),
    },
    async run(actor: Actor, a) {
      // A declaration applies to everything a team exports, so this is not a
      // per-project edit and an ordinary member should not make it.
      if (!isAnyAdmin(actor)) {
        return ok({ error: "Admins only â€” an export default applies to every project." });
      }
      const marketplace = String(a.marketplace).toLowerCase();
      const attribute = defaultKey(String(a.attribute));
      const value = String(a.value ?? "");

      // These are legal statements the seller makes. Recording WHO set one
      // and when is the point of doing it here rather than in a config file.
      const existing = await prisma.exportDefault.findFirst({
        where: { marketplace, attribute, teamId: actor.teamId ?? null },
        select: { id: true, value: true },
      });

      if (existing) {
        await prisma.exportDefault.update({ where: { id: existing.id }, data: { value } });
        return ok({ updated: true, marketplace, attribute, from: existing.value, to: value });
      }
      await prisma.exportDefault.create({
        data: { marketplace, attribute, value, teamId: actor.teamId ?? null },
      });
      return ok({ created: true, marketplace, attribute, value });
    },
  },

  {
    name: "rename_project",
    title: "Rename a project",
    description: "Change a project's name. Only projects you own.",
    schema: { projectId: z.string(), name: z.string().min(1).max(120) },
    async run(actor: Actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only rename projects you own." });
      }
      const name = String(a.name).trim().slice(0, 120);
      if (!name) return ok({ error: "A name is required." });
      await prisma.project.update({ where: { id }, data: { name } });
      return ok({ renamed: true, from: project.name, to: name });
    },
  },

  {
    name: "clear_product_field",
    title: "Clear a wrong value",
    description:
      "Blank a field that holds something wrong â€” a fabricated barcode, a bad category. Previews by default. An empty cell is correctable; a wrong one ships.",
    schema: {
      projectId: z.string(),
      field: z.enum(["upc", "brand", "marketplaceCategory", "imageUrl"]),
      matchName: z.string().optional(),
      apply: z.boolean().optional(),
    },
    async run(actor: Actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only change projects you own." });
      }

      const field = String(a.field) as "upc" | "brand" | "marketplaceCategory" | "imageUrl";
      const where = {
        projectId: id,
        ...(a.matchName ? { name: { contains: String(a.matchName), mode: "insensitive" as const } } : {}),
        NOT: { [field]: null },
      };

      const count = await prisma.product.count({ where });
      if (count === 0) return ok({ matched: 0, note: "Nothing to clear." });
      if (count > MAX_WRITE) {
        return ok({ error: `${count} products matched, over the ${MAX_WRITE} limit.`, matched: count });
      }
      if (a.apply !== true) {
        return ok({ preview: true, wouldClear: count, field, note: "Call again with apply=true." });
      }
      const res = await prisma.product.updateMany({ where, data: { [field]: null } });
      return ok({ cleared: res.count, field, project: project.name });
    },
  },

];

/**
 * The write tools this person's Claude may use right now: the ones they chose,
 * while the deployment switch is on.
 *
 * Read per request rather than carried in the token, so unticking a tool stops
 * it on the next call — the person should not have to revoke a token to take
 * back a permission.
 */
export async function writeToolsFor(userId: string): Promise<McpTool[]> {
  if (!flags.mcpWrite()) return [];
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { mcpWriteTools: true } });
  const chosen = new Set(user?.mcpWriteTools ?? []);
  return WRITE_TOOLS.filter((t) => chosen.has(t.name));
}
