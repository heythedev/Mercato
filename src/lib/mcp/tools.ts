import { z } from "zod";
import {
  CATEGORIZE_BATCH,
  CATEGORIZE_BATCH_MAX,
  DOWNLOAD_TICKET_TTL_MS,
  MAX_ROWS,
} from "./limits";
import { prisma } from "@/lib/db";
import {
  adminUserIds,
  canOperateProject,
  canReadProject,
  isAnyAdmin,
  projectListScope,
  templateOwnerIds,
  templateVisibilityOr,
  type Actor,
} from "@/lib/authz";
import {
  INLINE_TAXONOMY_MAX,
  categoryIndex,
  nextSegments,
} from "@/lib/categorize/taxonomy";
import { isUnresolvedSkuOnly } from "@/lib/ai/resolve-sku";
import { toUnfilledReport } from "@/lib/export/job-store";
import { normalizeKey, templateRequirements, type TemplateRequirements } from "@/lib/export/zip";
import { buildDownloadName } from "@/lib/export/filename";
import { hashSecret, newSecret } from "@/lib/oauth/core";
import { baseUrl } from "@/lib/oauth/metadata";
import { loadProductAttributes, storedAttribute } from "@/lib/export/product-attributes";
import { defaultFor, defaultKey, loadExportDefaults } from "@/lib/export/defaults";
import { neverInventColumn } from "@/lib/ai/match-dropdown";

/**
 * What Claude may do in Mercato, on behalf of one person.
 *
 * Every tool takes an `actor` and routes through the same helpers the web app
 * uses — projectListScope, canReadProject, templateVisibilityOr. Not similar
 * rules: the same functions. If a member cannot see a colleague's template in
 * the browser, the tool cannot fetch it either, and neither can drift from
 * the other, because there is only one implementation to drift from.
 *
 * Read-only, deliberately. Write tools are worth having — setting a category
 * across a filtered set, entering the three compliance declarations — but
 * they should be shaped by what people actually reach for, and nobody has
 * reached for anything yet. Adding them later is easy; withdrawing one that
 * turned out to be dangerous is not.
 */

export type ToolResult = { content: { type: "text"; text: string }[] };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

/** Caps exist so a tool cannot return a reply nothing can read. */


export type McpTool = {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  run: (actor: Actor, args: Record<string, unknown>) => Promise<ToolResult>;
};

/**
 * How many products one categorisation batch hands over.
 *
 * Small enough that the whole batch plus the taxonomy is readable in one go,
 * large enough that a 4,811-product catalogue is tens of calls rather than
 * hundreds. The caller loops until nothing is left, exactly as the export's
 * client does.
 */


/**
 * A vendor-supplied category, if the upload carried one.
 *
 * Part of what makes a bare SKU classifiable: "VIDA-110112" alone is not,
 * but the same row with a vendor category of "Outdoor Furniture" is.
 */
export function vendorCategoryOf(vendorData: unknown): string | null {
  if (!vendorData || typeof vendorData !== "object") return null;
  for (const [k, v] of Object.entries(vendorData as Record<string, unknown>)) {
    if (!/categor/i.test(k)) continue;
    const s = v == null ? "" : String(v).trim();
    if (s) return s;
  }
  return null;
}

/** A few vendor attributes, small enough not to crowd out the taxonomy. */
function vendorHints(vendorData: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!vendorData || typeof vendorData !== "object") return out;
  for (const [k, v] of Object.entries(vendorData as Record<string, unknown>)) {
    if (Object.keys(out).length >= 8) break;
    if (v == null) continue;
    const s = String(v).trim();
    if (!s || s.length > 120) continue;
    out[k] = s;
  }
  return out;
}

/**
 * Columns the product's OWN record already answers, which nobody should be
 * asked for.
 *
 * The requirement matrix lists every column a category requires, and plenty of
 * those are data rather than judgement: Name, Brand, Category, Short
 * Description, Offer Price. The export fills them from the product row and the
 * vendor file before any model is consulted — but seeding the questions from
 * the matrix put them straight back on the list, and a model handed a product
 * called "Ashley Larkinhurst Sofa" and asked for its Name will happily write
 * one. Measured against the live Mathis project the first time this ran:
 * twelve columns asked of one product, seven of them already answered.
 *
 * Checked per product, because what the vendor file carries varies row by row
 * — which is the reason the export checks it per row too.
 */
export function columnsAnsweredByProduct(p: {
  name?: string | null;
  brand?: string | null;
  description?: string | null;
  marketplaceCategory?: string | null;
  price?: number | null;
  vendorData?: unknown;
}): Set<string> {
  const keys = new Set<string>();
  const add = (value: unknown, ...aliases: string[]) => {
    const filled = typeof value === "string" ? value.trim() !== "" : value != null;
    if (filled) for (const a of aliases) keys.add(normalizeKey(a));
  };
  add(p.name, "name", "title", "product name", "product title", "item name");
  add(p.brand, "brand", "brand name", "manufacturer");
  add(p.marketplaceCategory, "category", "product category");
  add(p.description, "description", "short description", "long description", "product description");
  add(p.price, "price", "offer price", "list price", "retail price");
  // Whatever the vendor sheet carried for this row answers its own column.
  if (p.vendorData && typeof p.vendorData === "object") {
    for (const [k, v] of Object.entries(p.vendorData as Record<string, unknown>)) {
      if (v != null && String(v).trim() !== "") keys.add(normalizeKey(k));
    }
  }
  return keys;
}


export const TOOLS: McpTool[] = [
  {
    name: "next_categorization_batch",
    title: "Next products to categorise",
    description:
      "Hand over the next batch of uncategorised products together with the marketplace's valid category list. " +
      "Choose one EXACT path from that list per product, then call submit_categorization. Repeat until remaining is 0.",
    schema: {
      projectId: z.string(),
      limit: z.number().optional().describe(`Products to return (default ${CATEGORIZE_BATCH})`),
      categoryPrefix: z
        .string()
        .optional()
        .describe("For large taxonomies only: drill into this path to see the next level"),
      includeTaxonomy: z
        .boolean()
        .optional()
        .describe("Default true. Pass false once you have the list — it does not change between batches."),
    },
    async run(actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, marketplace: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      // Owner-only, like the write half. Handing someone a batch of work they
      // would then be refused permission to submit is a dead end, not a
      // courtesy.
      if (!canOperateProject(actor, project)) {
        return ok({ error: "You can only categorise projects you own." });
      }

      const index = categoryIndex(project.marketplace);
      if (!index) {
        return ok({
          error: `No category list is available for ${project.marketplace}, so nothing could be checked against one. Categorise this project in Mercato instead.`,
        });
      }

      const uncategorised = {
        projectId: id,
        OR: [{ marketplaceCategory: null }, { marketplaceCategory: "Uncategorized" }],
      };
      const batchSize = Math.min(Number(a.limit ?? CATEGORIZE_BATCH), CATEGORIZE_BATCH_MAX);
      const [total, remaining, candidates] = await Promise.all([
        prisma.product.count({ where: { projectId: id } }),
        prisma.product.count({ where: uncategorised }),
        // Over-fetch, because rows with nothing to classify are dropped below
        // and a batch of 40 should still come back with 40 usable products.
        prisma.product.findMany({
          where: uncategorised,
          select: { id: true, name: true, brand: true, vendorSku: true, description: true, vendorData: true },
          orderBy: { id: "asc" },
          take: batchSize * 5,
        }),
      ]);

      // Rows whose name is still a raw vendor code, with no description and no
      // vendor category, carry nothing to classify FROM. The categorise route
      // already skips them twice over — before spending an AI call and again
      // before trusting an answer that slipped through — and its comment says
      // every caller must agree on which rows are hopeless. This is the third
      // caller, so it uses the same function rather than its own judgement.
      //
      // Handing "VIDA-110112" to a model and asking for a category does not
      // get an honest refusal; it gets a confident guess that passes taxonomy
      // validation because the path it invents is real. That is the one
      // failure this whole tool was built to prevent, arriving by a different
      // door.
      const usable = [];
      let unclassifiable = 0;
      for (const p of candidates) {
        const bare = isUnresolvedSkuOnly({
          name: p.name,
          sku: p.vendorSku,
          description: p.description,
          vendorCategory: vendorCategoryOf(p.vendorData),
        });
        if (bare) { unclassifiable++; continue; }
        if (usable.length < batchSize) usable.push(p);
      }
      const rows = usable;

      // Big taxonomies are drilled into a level at a time. Walmart's 5,242
      // paths would otherwise crowd out the products they are meant to
      // classify — and truncating the list would mean offering a choice that
      // silently excludes the right answer.
      // The list is identical on every call, and Best Buy's is 1,450 paths —
      // roughly 90KB. Repeating that down a hundred batches is most of the
      // conversation spent re-reading something that has not changed.
      const want = a.includeTaxonomy !== false;
      const inline = index.paths.length <= INLINE_TAXONOMY_MAX;
      const taxonomy = !want
        ? { mode: "omitted" as const, count: index.paths.length, note: "Asked for; use the list from an earlier call." }
        : inline
        ? { mode: "full" as const, count: index.paths.length, paths: index.paths }
        : {
            mode: "drill" as const,
            count: index.paths.length,
            prefix: String(a.categoryPrefix ?? "") || null,
            options: nextSegments(index.paths, a.categoryPrefix ? String(a.categoryPrefix) : undefined),
            note: "Too large to list. Call again with categoryPrefix set to one of these to see the next level, until you reach full paths.",
          };

      // Nothing usable in the whole window: say what to do instead of
      // returning an empty list that reads like "finished".
      if (rows.length === 0 && remaining > 0) {
        return ok({
          project: { id: project.id, name: project.name, marketplace: project.marketplace },
          progress: { total, categorised: total - remaining, remaining },
          products: [],
          needsEnrichmentFirst: unclassifiable,
          error:
            `Every one of the next ${unclassifiable} products is a bare vendor code with no title, ` +
            "description or vendor category — there is nothing to classify from, and any category " +
            "chosen would be invented. Run Categorize in Mercato first: it resolves these codes to " +
            "real titles from the vendor catalogue and from other projects carrying the same SKUs. " +
            "Then come back.",
        });
      }

      return ok({
        project: { id: project.id, name: project.name, marketplace: project.marketplace },
        progress: { total, categorised: total - remaining, remaining },
        ...(unclassifiable
          ? {
              skipped: {
                count: unclassifiable,
                reason:
                  "Bare vendor codes with nothing to classify from. Not included, and they will be " +
                  "refused if submitted. Run Categorize in Mercato to resolve them to real titles first.",
              },
            }
          : {}),
        taxonomy,
        products: rows.map((p) => ({
          productId: p.id,
          name: p.name,
          brand: p.brand,
          sku: p.vendorSku,
          description: p.description ? p.description.slice(0, 300) : null,
          attributes: vendorHints(p.vendorData),
        })),
        instructions:
          "Pick one path per product, copied EXACTLY from the list above — anything not in it is refused, " +
          "and a shortened path would quietly route the product into the wrong export file. " +
          "Include a confidence 0-1; use a low one rather than guessing, and those rows stay flagged for review. " +
          "Then call submit_categorization and request the next batch.",
      });
    },
  },

  {
    name: "list_projects",
    title: "List projects",
    description:
      "Projects you can see, newest first. A member sees their own; a team admin sees their team's; the super admin sees all.",
    schema: {
      status: z.string().optional().describe("Filter by status, e.g. done, categorized, exporting"),
      marketplace: z.string().optional().describe("Filter by marketplace, e.g. mathis, bestbuy"),
      search: z.string().optional().describe("Match part of the project name"),
      limit: z.number().int().min(1).max(MAX_ROWS).optional(),
    },
    async run(actor, a) {
      const rows = await prisma.project.findMany({
        where: {
          ...projectListScope(actor),
          ...(a.status ? { status: String(a.status) } : {}),
          ...(a.marketplace ? { marketplace: { equals: String(a.marketplace), mode: "insensitive" } } : {}),
          ...(a.search ? { name: { contains: String(a.search), mode: "insensitive" } } : {}),
        },
        select: {
          id: true, name: true, marketplace: true, status: true, createdAt: true, updatedAt: true,
          user: { select: { email: true } },
          _count: { select: { products: true } },
        },
        orderBy: { updatedAt: "desc" },
        take: Number(a.limit ?? 50),
      });
      return ok(
        rows.map((p) => ({
          id: p.id,
          name: p.name,
          marketplace: p.marketplace,
          status: p.status,
          products: p._count.products,
          owner: p.user?.email ?? null,
          updatedAt: p.updatedAt,
        })),
      );
    },
  },

  {
    name: "get_project",
    title: "Project detail",
    description:
      "One project with its category breakdown and how far through the pipeline it is. Says where products were lost between upload and export.",
    schema: { projectId: z.string().describe("Project id from list_projects") },
    async run(actor, a) {
      const id = String(a.projectId);
      const p = await prisma.project.findUnique({
        where: { id },
        select: {
          id: true, name: true, marketplace: true, status: true, userId: true, teamId: true,
          createdAt: true, updatedAt: true, user: { select: { email: true } },
        },
      });
      if (!p) return ok({ error: "No such project" });
      // The same check the web app makes before rendering the page.
      if (!canReadProject(actor, p)) return ok({ error: "Not visible to you" });

      const [total, verified, categorised, uncategorised, byCategory] = await Promise.all([
        prisma.product.count({ where: { projectId: id } }),
        prisma.product.count({ where: { projectId: id, verifyStatus: { not: null } } }),
        prisma.product.count({
          where: { projectId: id, marketplaceCategory: { not: null }, NOT: { marketplaceCategory: "Uncategorized" } },
        }),
        prisma.product.count({
          where: { projectId: id, OR: [{ marketplaceCategory: null }, { marketplaceCategory: "Uncategorized" }] },
        }),
        prisma.product.groupBy({
          by: ["marketplaceCategory"],
          where: { projectId: id },
          _count: { _all: true },
          orderBy: { _count: { id: "desc" } },
          take: 25,
        }),
      ]);

      return ok({
        ...{ id: p.id, name: p.name, marketplace: p.marketplace, status: p.status },
        owner: p.user?.email ?? null,
        updatedAt: p.updatedAt,
        // Stated as a funnel, because "why is only 182 of 1,999 exportable?"
        // is the question people actually arrive with.
        pipeline: {
          uploaded: total,
          verified,
          categorised,
          uncategorised,
          exportable: categorised,
          note: "Uncategorised products go to Uncategorized.csv and are not placed in any template.",
        },
        topCategories: byCategory.map((c) => ({
          category: c.marketplaceCategory ?? "(none)",
          products: c._count._all,
        })),
      });
    },
  },

  {
    name: "find_products",
    title: "Find products",
    description:
      "Search products by SKU, barcode, name or category, within the projects you can see.",
    schema: {
      query: z.string().describe("Part of a SKU, barcode, product name or category"),
      projectId: z.string().optional().describe("Restrict to one project"),
      missingField: z
        .enum(["upc", "brand", "category", "image", "price"])
        .optional()
        .describe("Only products where this is empty — for chasing export gaps"),
      limit: z.number().int().min(1).max(MAX_ROWS).optional(),
    },
    async run(actor, a) {
      const q = String(a.query ?? "").trim();
      const visible = await prisma.project.findMany({
        where: {
          ...projectListScope(actor),
          ...(a.projectId ? { id: String(a.projectId) } : {}),
        },
        select: { id: true },
      });
      if (!visible.length) return ok({ products: [], note: "No projects visible to you" });

      const missing: Record<string, object> = {
        upc: { OR: [{ upc: null }, { upc: "" }] },
        brand: { OR: [{ brand: null }, { brand: "" }] },
        category: { OR: [{ marketplaceCategory: null }, { marketplaceCategory: "Uncategorized" }] },
        image: { OR: [{ imageUrl: null }, { imageUrl: "" }] },
        price: { price: null },
      };

      const rows = await prisma.product.findMany({
        where: {
          projectId: { in: visible.map((v) => v.id) },
          ...(q
            ? {
                OR: [
                  { name: { contains: q, mode: "insensitive" } },
                  { vendorSku: { contains: q, mode: "insensitive" } },
                  { upc: { contains: q } },
                  { marketplaceCategory: { contains: q, mode: "insensitive" } },
                ],
              }
            : {}),
          ...(a.missingField ? (missing[String(a.missingField)] as object) : {}),
        },
        select: {
          id: true, name: true, vendorSku: true, upc: true, brand: true,
          marketplaceCategory: true, verifyStatus: true,
          project: { select: { id: true, name: true } },
        },
        take: Number(a.limit ?? 50),
      });
      return ok({ count: rows.length, products: rows });
    },
  },

  {
    name: "export_readiness",
    title: "Export readiness",
    description:
      "For a project: which required columns would ship empty, how many rows each affects, and why. The question a client asks as 'the output sheet is wrong'.",
    schema: { projectId: z.string() },
    async run(actor, a) {
      const id = String(a.projectId);
      const p = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, marketplace: true, userId: true, teamId: true },
      });
      if (!p) return ok({ error: "No such project" });
      if (!canReadProject(actor, p)) return ok({ error: "Not visible to you" });

      const total = await prisma.product.count({ where: { projectId: id } });
      const checks: { field: string; where: object; why: string }[] = [
        { field: "upc / barcode", where: { OR: [{ upc: null }, { upc: "" }] },
          why: "From the vendor sheet, Synccentric, or nowhere. The model is not allowed to invent one." },
        { field: "brand", where: { OR: [{ brand: null }, { brand: "" }] },
          why: "From the vendor sheet or the catalogue lookup." },
        { field: "category", where: { OR: [{ marketplaceCategory: null }, { marketplaceCategory: "Uncategorized" }] },
          why: "Not matched to a marketplace category — excluded from every template file." },
        { field: "image", where: { OR: [{ imageUrl: null }, { imageUrl: "" }] },
          why: "A catalogue photograph or none. Never generated." },
      ];

      const gaps = await Promise.all(
        checks.map(async (c) => {
          const n = await prisma.product.count({ where: { projectId: id, ...c.where } });
          return { field: c.field, empty: n, of: total, why: c.why };
        }),
      );

      return ok({
        project: p.name,
        marketplace: p.marketplace,
        products: total,
        gaps: gaps.filter((g) => g.empty > 0),
        alwaysManual: [
          "California Proposition 65 warning",
          "PFAS declaration",
          "Contains embedded battery",
        ],
        alwaysManualNote:
          "Seller declarations. No catalogue carries them and the model is barred from guessing — they need a stated value.",
      });
    },
  },

  {
    name: "list_templates",
    title: "List templates",
    description:
      "Export templates you can use. A member sees their own plus the global ones; a team admin sees their team's too.",
    schema: { marketplace: z.string().optional() },
    async run(actor, a) {
      const { adminIds, teamAdminIds } = await templateOwnerIds();
      const rows = await prisma.exportTemplate.findMany({
        where: {
          ...(a.marketplace
            ? { marketplace: { equals: String(a.marketplace), mode: "insensitive" } }
            : {}),
          OR: templateVisibilityOr(actor, adminIds, teamAdminIds),
        },
        select: {
          id: true, name: true, marketplace: true, category: true, createdAt: true,
          user: { select: { email: true } },
        },
        orderBy: { createdAt: "desc" },
        take: MAX_ROWS,
      });
      return ok(
        rows.map((t) => ({
          id: t.id, name: t.name, marketplace: t.marketplace, category: t.category,
          owner: t.user?.email ?? "(global)",
        })),
      );
    },
  },

  {
    name: "usage_summary",
    title: "AI and API spend",
    description:
      "What the paid services cost over a window, by service and feature. Admins only — it covers the whole account.",
    schema: { days: z.number().int().min(1).max(90).optional().describe("Default 30") },
    async run(actor, a) {
      // Spend is an account-wide figure and cannot be meaningfully scoped to
      // one member's projects, so it is simply not offered to them.
      if (!isAnyAdmin(actor)) return ok({ error: "Admins only" });
      const days = Number(a.days ?? 30);
      const since = new Date(Date.now() - days * 86_400_000);

      const rows = await prisma.$queryRaw<
        { service: string; feature: string; calls: bigint; input: bigint; output: bigint; failed: bigint }[]
      >`
        select service, feature, count(*) as calls,
               coalesce(sum("inputTokens"),0) as input,
               coalesce(sum("outputTokens"),0) as output,
               count(*) filter (where not ok) as failed
        from "ServiceUsage"
        where "createdAt" >= ${since}
        group by 1,2 order by sum("inputTokens") desc nulls last limit 30`;

      const n = (v: bigint) => Number(v);
      const totalTokens = rows.reduce((s, r) => s + n(r.input) + n(r.output), 0) || 1;
      return ok({
        windowDays: days,
        byFeature: rows.map((r) => ({
          service: r.service,
          feature: r.feature,
          calls: n(r.calls),
          failed: n(r.failed),
          tokensIn: n(r.input),
          tokensOut: n(r.output),
          shareOfTokens: `${Math.round(((n(r.input) + n(r.output)) / totalTokens) * 100)}%`,
        })),
      });
    },
  },

  {
    name: "get_export_download",
    title: "A link to download the finished export",
    description:
      "A short-lived link for the project's most recent finished export. Give the person the link, or "
      + "fetch it yourself with the curl command. The file never passes through the conversation.",
    schema: {
      projectId: z.string(),
    },
    async run(actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, marketplace: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      if (!canReadProject(actor, project)) return ok({ error: "Not visible to you" });

      const job = await prisma.exportJob.findFirst({
        where: { projectId: id, status: "done" },
        orderBy: { updatedAt: "desc" },
        select: { id: true, extension: true, updatedAt: true, unfilledRequired: true },
      });
      if (!job) {
        return ok({ error: "No finished export for this project yet. Run one first with run_export." });
      }

      // Only the length is wanted, but Postgres has to hand over the column
      // to give it. Worth one read: a link to a payload that has been swept
      // away is worse than saying so now.
      const row = await prisma.exportJob.findUnique({ where: { id: job.id }, select: { zip: true } });
      const size = row?.zip ? (row.zip as unknown as Uint8Array).byteLength : 0;
      if (!size) return ok({ error: "That export's payload is gone — run the export again." });

      const token = newSecret("mrc_d_");
      const expiresAt = new Date(Date.now() + DOWNLOAD_TICKET_TTL_MS);
      // Clear this person’s dead tickets on the way past, so the table
      // does not grow a row per request for ever. Bounded to their own.
      await prisma.downloadTicket.deleteMany({
        where: { userId: actor.id, expiresAt: { lt: new Date() } },
      }).catch(() => {});
      await prisma.downloadTicket.create({
        data: { tokenHash: hashSecret(token), userId: actor.id, jobId: job.id, expiresAt },
      });

      const base = await baseUrl();
      const url = `${base}/api/exports/download?t=${token}`;
      const filename = buildDownloadName({
        projectName: project.name,
        marketplace: project.marketplace,
        extension: job.extension ?? "zip",
      });
      const report = toUnfilledReport(job.unfilledRequired);

      return ok({
        url,
        filename,
        sizeBytes: size,
        exportFinished: job.updatedAt,
        expiresAt,
        curl: `curl -L -o "${filename}" "${url}"`,
        // Said here because somebody is about to decide whether to paste this
        // link somewhere, and that choice depends on knowing what it is.
        note:
          "Treat the link as a password: anyone holding it can fetch this export until it expires. "
          + "It is good for a few downloads and then stops.",
        ...(report.columns.length
          ? {
              warning:
                `${report.columns.length} required column(s) shipped empty in this export`
                + (report.aiUnavailable ? " — the AI account was unreachable when it ran" : "")
                + ". Call next_export_gaps to see which, and submit_export_values to fill them.",
            }
          : {}),
      });
    },
  },

  {
    name: "next_export_gaps",
    title: "Required cells nothing has answered yet",
    description:
      "Products whose required template columns have no value, with each product's own data to answer from " +
      "and the values already in use for that column. Works BEFORE the first export — the columns come from " +
      "the template's own requirement matrix — so answer these with submit_export_values and the export runs " +
      "once and comes out right, with no AI call and no credit needed. Also lists the required columns no " +
      "model may answer, which need a person.",
    schema: {
      projectId: z.string(),
      column: z.string().optional().describe("One column only, e.g. Material"),
      limit: z.number().optional(),
    },
    async run(actor, a) {
      const id = String(a.projectId);
      const project = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, marketplace: true, userId: true, teamId: true },
      });
      if (!project) return ok({ error: "No such project" });
      if (!canReadProject(actor, project)) return ok({ error: "Not visible to you" });

      // What the last export could not fill, if there has been one. This is
      // measured rather than predicted, and it carries the dropdown options,
      // so it is still read — but it is no longer what DECIDES the questions.
      //
      // It used to be. That made an export the only way to discover a gap:
      // run at $0.00 credit, watch Style, Material and Finish Color ship
      // blank, read the list back, fill it, run again. Two runs, the first of
      // them wrong, to answer questions the template could have been asked
      // directly. The requirement matrix already knows what each category
      // demands before anything is built.
      const job = await prisma.exportJob.findFirst({
        where: { projectId: id, status: "done" },
        orderBy: { updatedAt: "desc" },
        select: { unfilledRequired: true, updatedAt: true },
      });
      const report = toUnfilledReport(job?.unfilledRequired);
      const reportedColumns = report.columns.map((c) => c.label);
      const wantOnly = a.column ? defaultKey(String(a.column)) : null;

      const products = await prisma.product.findMany({
        where: { projectId: id, marketplaceCategory: { not: null }, NOT: { marketplaceCategory: "Uncategorized" } },
        select: { id: true, name: true, description: true, brand: true, vendorSku: true, price: true, vendorData: true, marketplaceCategory: true },
        orderBy: { id: "asc" },
        take: 500,
      });
      const stored = await loadProductAttributes(products.map((p) => p.id));

      // The template's requirement matrix decides which of those columns a
      // given product actually needs. Without this the list is the union of
      // every category's unfilled columns, which asks a pet stand for a Bed
      // Size and a Halloween backdrop for a Seat Height — cells the template
      // marks not-applicable and the client's import requires EMPTY.
      //
      // Templates that carry no matrix (Walmart, Temu) yield nothing here and
      // the unscoped list stands: no matrix means no opinion, and narrowing
      // on a guess would hide real gaps.
      const { adminIds, teamAdminIds } = await templateOwnerIds();
      const tpls = await prisma.exportTemplate.findMany({
        where: {
          marketplace: { equals: project.marketplace, mode: "insensitive" },
          OR: templateVisibilityOr(actor, adminIds, teamAdminIds),
        },
        select: { fileData: true },
        orderBy: { createdAt: "asc" },
        take: 40,
      });
      const matrices: TemplateRequirements[] = [];
      for (const t of tpls) {
        if (!t.fileData) continue;
        const req = await templateRequirements(t.fileData as Buffer, project.marketplace).catch(() => null);
        if (req) matrices.push(req);
      }
      // A category is covered by exactly one of these templates in practice, so
      // the first matrix that knows the category is the one that governs it.
      //
      // With a matrix the required columns come FROM it, which is what lets
      // this run before any export. Without one (Walmart, Temu) there is no
      // opinion to narrow by and the last export's report is all there is —
      // those marketplaces still need a run first, and are told so.
      const requiredFor = (category: string | null): string[] => {
        if (!category) return reportedColumns;
        const owner = matrices.find((m) => m.pathFor(category) !== "");
        if (!owner) return reportedColumns;
        const fromMatrix = owner.requiredColumns(category);
        return fromMatrix.length ? fromMatrix : reportedColumns.filter((c) => owner.requires(category, c));
      };

      /**
       * Columns a model must not answer, split out rather than dropped.
       *
       * These are the same columns Mercato's own fill refuses — identifiers,
       * measurements, and the seller's declarations — and the reason is the
       * reason: a guessed barcode attaches the listing to somebody else's
       * product, a guessed Proposition 65 answer is a false legal statement
       * published under the client's name. Claude guessing them instead of
       * Kimi guessing them is the same wrong answer from a different model.
       *
       * They are still REQUIRED, so staying silent about them just moves the
       * blank cell somewhere nobody is looking. They come back as work for a
       * person: a declaration is stated once with set_export_default, and a
       * measurement comes from the catalogue lookup or not at all.
       */
      const forAPerson = (column: string): boolean =>
        neverInventColumn(normalizeKey(column)) || neverInventColumn(defaultKey(column));


      // The vocabulary already in use for each column, across this
      // marketplace. Not the template's own dropdown — that lives inside the
      // workbook — but real values Mercato has accepted before, which is a
      // far better prompt than nothing and keeps answers consistent with
      // what is already in the catalogue.
      const inUse = new Map<string, Set<string>>();
      for (const [, attrs] of stored) {
        for (const [k, v] of attrs) {
          if (!inUse.has(k)) inUse.set(k, new Set());
          if (inUse.get(k)!.size < 40) inUse.get(k)!.add(v);
        }
      }

      const gaps: unknown[] = [];
      const cap = Math.min(Number(a.limit ?? 25), 60);
      // Counted across the whole catalogue, not just the page of products
      // handed back, so "who needs a person" is a total and not a sample.
      const personColumns = new Map<string, number>();
      for (const p of products) {
        const attrs = stored.get(p.id);
        const wanted = requiredFor(p.marketplaceCategory).filter(
          (c) => !wantOnly || defaultKey(c) === wantOnly,
        );
        const own = columnsAnsweredByProduct(p);
        const unanswered = wanted.filter((c) => !storedAttribute(attrs, c) && !own.has(normalizeKey(c)));
        for (const c of unanswered.filter(forAPerson)) {
          personColumns.set(c, (personColumns.get(c) ?? 0) + 1);
        }
        if (gaps.length >= cap) continue;
        const missing = unanswered.filter((c) => !forAPerson(c));
        if (!missing.length) continue;
        gaps.push({
          productId: p.id,
          name: p.name,
          brand: p.brand,
          sku: p.vendorSku,
          category: p.marketplaceCategory,
          description: p.description ? p.description.slice(0, 400) : null,
          vendorData: vendorHints(p.vendorData),
          needs: missing,
        });
      }

      // Which declarations already have a stated value, so a person is only
      // asked for what is actually outstanding.
      const defaults = await loadExportDefaults(project.marketplace, actor.teamId).catch(
        () => new Map<string, string>(),
      );
      const needsAPerson = [...personColumns]
        .map(([column, rows]) => ({ column, rows, currentDefault: defaultFor(defaults, column) || null }))
        .filter((c) => !c.currentDefault)
        .sort((a2, b2) => b2.rows - a2.rows);

      if (!gaps.length && !needsAPerson.length) {
        return ok({
          project: { id: project.id, name: project.name, marketplace: project.marketplace },
          products: [],
          note:
            matrices.length || job
              ? "Every required column for these products is already answered. Run the export."
              : "No requirement matrix for this marketplace and no finished export yet — run one first and "
                + "it will record what it could not fill.",
        });
      }

      return ok({
        project: { id: project.id, name: project.name, marketplace: project.marketplace },
        // Derived from the templates themselves when they carry a matrix, so
        // this answers before the first export rather than after it.
        source: matrices.length ? "template requirement matrix" : "the last finished export",
        reportedBy: job ? `the export finished ${job.updatedAt.toISOString()}` : null,
        columnsStillEmpty: report.columns,
        scopedByTemplate: matrices.length > 0,
        // The columns that accept only a fixed list, and what that list is.
        // Recorded by the export itself, so these are the values it will
        // take verbatim — anything else is dropped on the way into the file.
        allowedValues: report.dropdowns ?? {},
        valuesAlreadyInUse: Object.fromEntries([...inUse].map(([k, v]) => [k, [...v]])),
        products: gaps,
        // Required, outstanding, and barred from every model — Mercato's and
        // yours alike. Do not answer these in submit_export_values; it refuses
        // them for the same reason the export does.
        needsAPerson,
        needsAPersonNote: needsAPerson.length
          ? "Required columns no model may answer. A declaration (Proposition 65, PFAS, battery) is the "
            + "seller's own statement — ask the person, then store it once with set_export_default and it "
            + "applies to every export for this marketplace. A measurement or identifier comes from the "
            + "vendor file or the catalogue lookup, or it stays empty."
          : undefined,
        instructions:
          "Each product is asked only for the columns ITS OWN category requires. Where a column appears in "
          + "allowedValues it takes ONE OF THOSE STRINGS EXACTLY — anything else is refused, so pick from the "
          + "list or leave it out. Answer only from that product's "
          + "name, description and vendor data. If a product does not state " +
          "a value, leave it out — a seat height invented for a mattress becomes a fact on a storefront. " +
          "Prefer a value already in use for that column. Then call submit_export_values.",
      });
    },
  },

  {
    name: "job_status",
    title: "What is running",
    description:
      "Where a project is in the pipeline: whether categorisation, verification or an export is running, how " +
      "far through, and what is left. Call this after starting a run rather than guessing.",
    schema: { projectId: z.string() },
    async run(actor, a) {
      const id = String(a.projectId);
      const p = await prisma.project.findUnique({
        where: { id },
        select: {
          id: true, name: true, marketplace: true, status: true, userId: true, teamId: true,
          categorizeCompletedAt: true, verifyCompletedAt: true, updatedAt: true,
        },
      });
      if (!p) return ok({ error: "No such project" });
      if (!canReadProject(actor, p)) return ok({ error: "Not visible to you" });

      const [total, categorised, verified, job] = await Promise.all([
        prisma.product.count({ where: { projectId: id } }),
        prisma.product.count({
          where: { projectId: id, marketplaceCategory: { not: null }, NOT: { marketplaceCategory: "Uncategorized" } },
        }),
        prisma.product.count({ where: { projectId: id, verifyStatus: { not: null } } }),
        prisma.exportJob.findFirst({
          where: { projectId: id },
          orderBy: { updatedAt: "desc" },
          select: { id: true, status: true, phase: true, pendingGroups: true, totalGroups: true, updatedAt: true },
        }),
      ]);

      const pending = ((job?.pendingGroups as string[] | null) ?? []).length;
      return ok({
        project: { id: p.id, name: p.name, marketplace: p.marketplace },
        // The project's own status word is what every screen shows, so it is
        // the one answer to "is something running".
        status: p.status,
        running: ["categorizing", "verifying", "exporting"].includes(p.status),
        products: { total, categorised, uncategorised: total - categorised, verified },
        categorizeFinishedAt: p.categorizeCompletedAt,
        verifyFinishedAt: p.verifyCompletedAt,
        export: job
          ? {
              jobId: job.id,
              status: job.status,
              phase: job.phase,
              filesLeft: pending,
              filesTotal: job.totalGroups ?? 0,
              updatedAt: job.updatedAt,
            }
          : null,
        lastActivity: p.updatedAt,
      });
    },
  },

  {
    name: "verification_issues",
    title: "What verification flagged",
    description:
      "Products whose verdict is not a clean match, with the stored value against the live marketplace value " +
      "for each field that differs. Use it to triage mismatches instead of opening them one by one.",
    schema: {
      projectId: z.string(),
      verdict: z
        .enum(["warning", "mismatch", "not_found", "discontinued"])
        .optional()
        .describe("Only this verdict; omit for all of them"),
      limit: z.number().optional(),
    },
    async run(actor, a) {
      const id = String(a.projectId);
      const p = await prisma.project.findUnique({
        where: { id },
        select: { id: true, name: true, marketplace: true, userId: true, teamId: true },
      });
      if (!p) return ok({ error: "No such project" });
      if (!canReadProject(actor, p)) return ok({ error: "Not visible to you" });

      const verdicts = a.verdict ? [String(a.verdict)] : ["warning", "mismatch", "not_found", "discontinued"];
      const [counts, rows] = await Promise.all([
        prisma.product.groupBy({
          by: ["verifyStatus"],
          where: { projectId: id, verifyStatus: { not: null } },
          _count: { _all: true },
        }),
        prisma.product.findMany({
          where: { projectId: id, verifyStatus: { in: verdicts } },
          select: { id: true, name: true, vendorSku: true, upc: true, asin: true, verifyStatus: true, verifyFields: true },
          take: Math.min(Number(a.limit ?? 40), MAX_ROWS),
          orderBy: { id: "asc" },
        }),
      ]);

      return ok({
        project: p.name,
        byVerdict: Object.fromEntries(counts.map((c) => [c.verifyStatus ?? "unverified", c._count._all])),
        products: rows.map((r) => ({
          productId: r.id,
          name: r.name,
          sku: r.vendorSku,
          barcode: r.upc,
          asin: r.asin,
          verdict: r.verifyStatus,
          // Only the fields that disagree — a verdict with twenty matching
          // fields attached is a verdict nobody reads.
          //
          // Filtered on SEVERITY, not on `match`. The two are independent in
          // the stored data and the important rows prove it: a product whose
          // brand reads "R1 Concepts" against a live "Dynamic Friction"
          // carries match=true with severity=warning. Filtering on match
          // alone dropped exactly the disagreements worth looking at.
          differences: Array.isArray(r.verifyFields)
            ? (r.verifyFields as Record<string, unknown>[])
                .filter((f) => f && (f.severity !== "ok" || f.match === false))
                .map((f) => ({
                  field: f.label ?? f.field,
                  ours: String(f.stored ?? "").slice(0, 160),
                  live: String(f.live ?? "").slice(0, 160),
                  severity: f.severity,
                  note: f.note,
                }))
            : [],
        })),
        note:
          "A difference is not automatically a fault — a colour named differently, or a pack size written another " +
          "way, is the common case. Say which look like real problems and reverify_product can re-check one.",
      });
    },
  },

  {
    name: "start_new_project",
    title: "Start a new project",
    description:
      "Where to create a project. Mercato needs the vendor spreadsheet to create one, and a spreadsheet cannot " +
      "travel through this connection — so this returns the link to do it in Mercato, with what to expect.",
    schema: { marketplace: z.string().optional() },
    async run(actor, a) {
      void actor;
      const mp = String(a.marketplace ?? "").trim();
      return ok({
        // Honest rather than useless: Claude cannot carry a file, so the one
        // helpful thing is to say exactly where to go and what happens next,
        // instead of reporting that it has no tool and stopping.
        openInMercato: "/projects/new",
        ...(mp ? { marketplace: mp } : {}),
        why: "A project is created from the vendor file itself, and a spreadsheet would be megabytes of encoded text through this conversation.",
        thenWhatIcanDo: [
          "job_status — follow categorisation, verification or an export",
          "next_categorization_batch + submit_categorization — categorise it with me",
          "run_categorization / run_verification / run_export — start Mercato's own runs",
          "export_readiness — which required columns would ship empty",
          "verification_issues — triage what verification flagged",
        ],
      });
    },
  },

  {
    name: "whoami",
    title: "Who am I",
    description: "The Mercato account this connection acts as, and what it can reach.",
    schema: {},
    async run(actor) {
      const [projects, admins] = await Promise.all([
        prisma.project.count({ where: projectListScope(actor) }),
        adminUserIds(),
      ]);
      return ok({
        userId: actor.id,
        role: actor.role,
        teamId: actor.teamId,
        visibleProjects: projects,
        isSuperAdmin: admins.includes(actor.id),
        note: "Every tool is scoped to this account — the same as what you see signed in.",
      });
    },
  },
];
