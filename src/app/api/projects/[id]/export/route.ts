import { NextRequest, NextResponse } from "next/server";
import { actorOf, adminUserIds, canOperateProject, canReadJob, templateVisibilityOr } from "@/lib/authz";
import { after } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { enterAiContext } from "@/lib/ai/usage-context";
import { flushUsage } from "@/lib/ai/usage-log";
import { prisma, inChunks } from "@/lib/db";
import type { ExportTemplate, Prisma } from "@prisma/client";
import { generateBestBuyCategoryZip, generateCategoryZip, generateExportZip, generateFlatCategoryZip, generateFlatExport, generateSingleTemplateExport, mergeZips, splitBestBuyByTemplate, unfilledByColumn, unwrapSingleFileZip, type TemplateRow } from "@/lib/export/zip";
import { getBestBuyColumnsForCategories } from "@/lib/export/bestbuy-template";
import { miraklConfigured } from "@/lib/bestbuy/mirakl-client";
import { checkAiAvailable } from "@/lib/ai/moonshot";
import { setDropdownDeadline } from "@/lib/ai/match-dropdown";
import {
  assembleJobZip,
  createJob,
  getJobStatus,
  getJobZip,
  markGroupsDone,
  rejectJob,
  resolveJob,
  saveJobFiles,
  setJobPhase,
  setJobPlan,
  touchJob,
} from "@/lib/export/job-store";
import { buildDownloadName, contentDisposition } from "@/lib/export/filename";
import { exportGroupOf } from "@/lib/export/category-group";

export const maxDuration = 300;

// The catalog image back-fill scrapes the vendor's site per SKU. A SKU-only
// sheet where every product is missing an image (852 Vickerman rows) turns
// that into a minutes-long network sweep that outlives the function — so it
// gets a hard time budget instead. Fills are persisted, so each export run
// picks up where the previous one stopped and the catalog heals incrementally.
const BACKFILL_BUDGET_MS = 120_000;

// Wall-clock budget for AI dropdown/mandatory-cell filling, measured from the
// start of the job. maxDuration is 300s; stopping at 180s leaves room for the
// image back-fill, the template writes and storing the ZIP. Cells not filled in
// time land in Missing_Mandatory_Fields.csv — the same path an AI failure takes.
const DROPDOWN_BUDGET_MS = 180_000;

// How long ONE slice of a sliced export may run before it stops and hands the
// rest to the next request. maxDuration is 300s; stopping at 210s leaves room
// to write the finished files and report back. A job killed at the ceiling
// still keeps whatever it had written — that is the point of slicing — but
// stopping deliberately is faster, because a killed invocation loses the
// in-flight group.
// Overridable so the slicing can be exercised without a 4,000-product
// catalogue: set it to 1 and every request does exactly one group.
const SLICE_BUDGET_MS = Number(process.env.EXPORT_SLICE_BUDGET_MS) || 210_000;

/**
 * Output groups this project will produce, cheapest way possible.
 *
 * Counted in SQL from the distinct categories: the plan has to exist before
 * any products are loaded, and loading 4,811 rows just to list twelve groups
 * is the cost this avoids.
 */
async function planGroups(projectId: string, marketplace: string): Promise<string[]> {
  const rows = await prisma.product.groupBy({
    by: ["marketplaceCategory"],
    where: { projectId },
    _count: { _all: true },
  });
  const groups = new Set<string>();
  for (const r of rows) {
    const cat = r.marketplaceCategory;
    // Uncategorized rows are written as their own file by every category-split
    // path, so they are a group like any other and must be sliced like one.
    groups.add(!cat || cat === "Uncategorized" ? UNCATEGORIZED_GROUP : exportGroupOf(cat, marketplace));
  }
  return [...groups];
}

const UNCATEGORIZED_GROUP = "__uncategorized__";

// Poll job status / download completed ZIP
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const job = await getJobStatus(jobId);
  // A job belonging to someone else reads as absent rather than Forbidden —
  // jobIds encode the project id, no need to confirm they exist to outsiders.
  if (!job || !canReadJob(actorOf(user), job)) {
    return NextResponse.json({ error: "Job not found or expired" }, { status: 404 });
  }

  if (job.status === "processing") {
    // Echo the phase and a heartbeat so the client can show real progress and
    // tell a slow-but-alive job apart from a stalled one.
    return NextResponse.json({
      status: "processing",
      phase: job.phase ?? "Preparing…",
      updatedAt: job.updatedAt,
    });
  }

  if (job.status === "error") {
    return NextResponse.json({ status: "error", error: job.error }, { status: 500 });
  }

  // Done — serve the ZIP under a human-readable name
  // ("mercato-Spring Catalog-mathis-23-07-2026.zip" rather than the raw project id).
  // The payload is fetched only now, so the poll loop never drags the BYTEA
  // column across the wire.
  const [zip, meta] = await Promise.all([
    getJobZip(jobId),
    prisma.project.findUnique({
      where: { id },
      select: { name: true, marketplace: true },
    }),
  ]);
  if (!zip) return NextResponse.json({ error: "Export payload missing — please run the export again" }, { status: 410 });
  // Single-file exports are served as the spreadsheet itself, so the extension
  // and MIME type follow whatever the job actually stored.
  const extension = job.extension ?? "zip";
  const contentType = job.contentType ?? "application/zip";
  const filename = buildDownloadName({
    projectName: meta?.name,
    marketplace: meta?.marketplace,
    extension,
  });

  const missing = job.missingTemplateCategories;
  return new Response(zip as unknown as BodyInit, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": contentDisposition(filename),
      // Temu categories that had no matching template — client reads this to show
      // an "upload a template for these categories" warning after download.
      "X-Missing-Template-Categories": missing.map(encodeURIComponent).join(","),
      // Required columns that shipped empty, as "label:rows" pairs. The client
      // turns each into a one-click "set a default" so the gap is fixed where it
      // is discovered, rather than on a separate admin screen.
      "X-Unfilled-Required": job.unfilledRequired.columns
        .map((c) => `${encodeURIComponent(c.label)}:${c.rows}`)
        .join(","),
      // "1" when the AI could not be reached during the run, so the client
      // reports a provider outage instead of inviting a fixed default for a
      // column the AI would normally fill per product.
      "X-Unfilled-Ai-Down": job.unfilledRequired.aiUnavailable ? "1" : "0",
      "Access-Control-Expose-Headers":
        "X-Missing-Template-Categories, X-Unfilled-Required, X-Unfilled-Ai-Down",
    },
  });
}

// Start export job — lightweight auth + existence check only, then returns { jobId } immediately.
// All heavy DB queries (products, template fileData) run inside the background job.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;
  // Exports spend on several paths (dropdown fills, mandatory-cell enrichment,
  // title generation); each narrows the feature itself.
  enterAiContext({ feature: "export_dropdown", projectId: id, userId: (user as { id?: string })?.id });
  // Buffered usage rows would otherwise be lost if the instance freezes
  // the moment it responds — the tail of a long run is its costliest part.
  after(() => flushUsage());

  const body = await req.json().catch(() => ({}));
  const autoMatch: boolean = body.autoMatch ?? false;
  const templateId: string | undefined = body.templateId;
  const templateIds: string[] = body.templateIds ?? [];

  if (!autoMatch && !templateId && !templateIds.length) {
    return NextResponse.json({ error: "autoMatch, templateId or templateIds required" }, { status: 400 });
  }

  // Lightweight check — just ownership, no heavy data loaded
  const projectMeta = await prisma.project.findUnique({
    where: { id },
    select: { id: true, userId: true, marketplace: true, teamId: true },
  });
  if (!projectMeta) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!canOperateProject(actorOf(user), projectMeta)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Continuing an export that ran out of invocation rather than starting one.
  const continueId = req.nextUrl.searchParams.get("jobId");
  const existing = continueId ? await getJobStatus(continueId) : null;
  if (continueId && (!existing || !canReadJob(actorOf(user), existing))) {
    return NextResponse.json({ error: "Job not found or expired" }, { status: 404 });
  }
  const continuing = !!existing && existing.status === "processing";
  const existingPending = existing?.pendingGroups ?? [];

  const jobId = continuing ? continueId! : `${id}_${Date.now()}`;
  if (!continuing) await createJob(jobId, id, user!.id);

  const plan = continuing
    ? existing!.pendingGroups
    : await planGroups(id, projectMeta.marketplace);
  // The job's ORIGINAL group count, so progress counts up rather than the
  // total shrinking with every pass (1/5, then 1/4, then 1/3 …).
  const totalGroups = continuing
    ? existing!.totalGroups || existing!.pendingGroups.length
    : plan.length;

  // Accumulated across the slices of one job, and reported once at the end.
  const sliceMissing: string[] = [];
  const sliceUnfilled: { label: string; rows: number }[] = [];
  let sliceAiDown = false;

  // All heavy work (loading products JSON, loading template fileData BYTEA)
  // runs after the response. `after()` matters on Vercel: a bare fire-and-forget
  // promise has no guaranteed CPU once the response is sent — the instance can
  // be frozen mid-query, which leaked pool connections until the next export
  // died with "timeout exceeded when trying to connect". `after()` keeps the
  // function alive (up to maxDuration) until the job finishes.
  /**
   * Run the export for `sliceGroups`, or for everything when it is null.
   *
   * Returns the files it produced rather than writing the finished ZIP, so a
   * sliced job can keep them and continue in the next request.
   */
  // An arrow expression, not a declaration: a hoisted function is treated as
  // callable before the null check above, so TypeScript would stop narrowing
  // projectMeta inside it.
  const runJob = async (sliceGroups: string[] | null): Promise<void> => {
    const jobStartedAt = Date.now();
    // Cap the AI dropdown/mandatory-cell fill so it can never consume the whole
    // invocation. It was unbounded — one model round-trip per category per
    // template — which is why 8 consecutive Mathis exports of only 24-40
    // products died at "Building spreadsheet files…" while a 1,251-product
    // Walmart export (no dropdown fill) finished in under three minutes.
    // Leaves ~90s to write and store the ZIP after the fill stops.
    setDropdownDeadline(jobStartedAt + DROPDOWN_BUDGET_MS);
    // Mark exporting inside the background job so the POST can return the jobId
    // immediately without a DB round-trip. Previously this was awaited in the
    // request handler — if the DB was slow or the connection pool was exhausted
    // the await could hang for 30s and Render's proxy would 502 the request.
    await prisma.project.update({ where: { id }, data: { status: "exporting" } }).catch(() => {});
    // Heartbeat: bump updatedAt every 20s for the whole job so long single
    // operations (the product load, one giant model batch) never look dead to
    // the client's stall detector even when the phase string is unchanged.
    const heartbeat = setInterval(() => { void touchJob(jobId); }, 20_000);
    try {
      const useAutoMatch = autoMatch || !!templateId;
      const useTemplateIds = !autoMatch && !templateId && templateIds.length > 0;

      // "amazon_us" and "amazon" share the same template pool; use lowercase for case-insensitive match
      const mp = projectMeta.marketplace;
      const mpLower = mp.toLowerCase();
      const mpFamily = mpLower === "amazon_us" || mpLower === "amazon" ? ["amazon_us", "amazon"] : [mpLower];

      // Own templates, the global ones, and anything an admin uploaded before
      // the userId=null convention — the same rule the Templates screen uses.
      const templateOwnerOr = templateVisibilityOr(actorOf(user), await adminUserIds());

      // Include fileData so category-zip exports can use fillTemplateXlsx and preserve
      // original template formatting, column widths, styles, and dropdown validations.
      // userId is included so we can prefer user-uploaded templates over admin/global ones.
      await setJobPhase(jobId, "Loading products…");
      const templateSelect = { id: true, name: true, marketplace: true, category: true, fileFormat: true, columns: true, fileData: true, userId: true };
      // Select only the columns the export actually reads. `include: products`
      // pulled every column, and `liveData` alone (Walmart's full listing
      // payload, ~13KB per product) made this 87MB / ~68s for a 7k project —
      // before a single row was written. The fields below are every product
      // property referenced by the template writer.
      const productSelect = {
        id: true,
        name: true,
        vendorSku: true,
        upc: true,
        asin: true,
        brand: true,
        price: true,
        description: true,
        imageUrl: true,
        marketplaceCategory: true,
        categoryPath: true,
        specProductType: true,
        verifyStatus: true,
        vendorData: true,
        // liveData is fetched separately and slimmed — see below.
      } as const;
      const [project, rawTemplates, liveDataRows] = await Promise.all([
        prisma.project.findUnique({
          where: { id },
          include: { products: { select: productSelect } },
        }),
        useAutoMatch
          ? prisma.exportTemplate.findMany({
              where: { marketplace: { in: mpFamily, mode: "insensitive" }, OR: templateOwnerOr },
              select: templateSelect,
              orderBy: { createdAt: "asc" },
            })
          : prisma.exportTemplate.findMany({
              where: { id: { in: templateIds }, OR: templateOwnerOr },
              select: templateSelect,
              orderBy: { createdAt: "asc" },
            }),
        // liveData holds Walmart's full listing payload (~13KB/product), but the
        // export reads only a handful of scalar fields from it. Stripping the
        // heavy nested values IN SQL cuts the transferred payload roughly 3x
        // (76MB → 26MB on a 7k project) instead of shipping them across the wire
        // just to ignore them.
        //
        // `- 'key'` removes a top-level key from a jsonb value. Only `variants`
        // and `imageEntities` are dropped: they are the two largest fields
        // (~45% of the payload) and nothing reads them — the image angles the
        // export needs are already flattened into `images`. Description and
        // image fields are KEPT, because the generic "match a template column
        // name against a liveData key" fallback can legitimately resolve a
        // Description or Image column from them.
        prisma.$queryRawUnsafe<Array<{ id: string; liveData: unknown }>>(
          `SELECT id, ("liveData" - 'variants' - 'imageEntities') AS "liveData"
           FROM "Product"
           WHERE "projectId" = $1 AND "liveData" IS NOT NULL`,
          id,
        ),
      ]);

      // Both user-uploaded and admin/global templates are included in the export pool.
      // When the user has uploaded a template with the same name as an admin template,
      // the user's version replaces the admin's — so their customisation takes effect
      // without losing access to admin templates they haven't overridden.
      const userOwnTemplates = rawTemplates.filter(t => t.userId === user!.id);
      const adminTemplates   = rawTemplates.filter(t => t.userId !== user!.id);
      const userNames = new Set(userOwnTemplates.map(t => t.name.toLowerCase().trim()));
      const nonOverriddenAdmin = adminTemplates.filter(t => !userNames.has(t.name.toLowerCase().trim()));
      const allTemplates = [...userOwnTemplates, ...nonOverriddenAdmin] as TemplateRow[];

      if (!project) throw new Error("Project not found");

      // Attach the slimmed liveData fetched above. Products with no verification
      // result simply have none, matching the previous behaviour.
      const liveById = new Map(liveDataRows.map((r) => [r.id, r.liveData]));
      type ExportProduct = (typeof project.products)[number] & { liveData: Prisma.JsonValue };
      let products: ExportProduct[] = project.products.map((p) => ({
        ...p,
        liveData: (liveById.get(p.id) ?? null) as Prisma.JsonValue,
      }));

      // Narrow the catalogue to this slice. Everything below — the back-fill,
      // the AI fill, the template writes — then works on a set that fits inside
      // one invocation, and the groups it finishes are kept.
      if (sliceGroups) {
        const wanted = new Set(sliceGroups);
        products = products.filter((p) => {
          const cat = p.marketplaceCategory;
          const group =
            !cat || cat === "Uncategorized"
              ? UNCATEGORIZED_GROUP
              : exportGroupOf(cat, projectMeta.marketplace);
          return wanted.has(group);
        });
        console.log(
          `[export] slice of ${sliceGroups.length} group(s) → ${products.length} products`,
        );
      }

      // ── Catalog back-fill: names + images + attributes ────────────────────────
      // SKU-only vendor sheets carry no titles/images/size/color; those come from the
      // vendor's own catalog (Modway/TOV/Vickerman). Categorize-time enrichment only
      // runs for rows whose name is still a raw code, so a project categorized before
      // attribute support was added would permanently miss its images. Filling here —
      // right before the template is written — makes the export self-sufficient
      // regardless of when (or whether) enrichment ran. Rows whose name is still the
      // raw vendor code also take the catalog's real title/brand/description, so the
      // exported Name column never shows a bare SKU the catalog can resolve. Results
      // are persisted so subsequent exports skip the network entirely.
      try {
        const { fillCatalogAttributes, looksLikeSkuName } = await import("@/lib/ai/resolve-sku");
        const fills = await fillCatalogAttributes(
          products,
          (done, total) => { void setJobPhase(jobId, `Fetching product images ${done}/${total}…`); },
          { deadline: Date.now() + BACKFILL_BUDGET_MS },
        );
        if (fills.size > 0) {
          // Rows whose stored name is still a raw code get the catalog title; a name a
          // human (or a prior run) already resolved is never overwritten.
          const renamedIds = new Set<string>();
          products = products.map((p) => {
            const f = fills.get(p.id);
            if (!f) return p;
            const takeTitle = !!f.title && looksLikeSkuName(p.name, p.vendorSku);
            if (takeTitle) renamedIds.add(p.id);
            return {
              ...p,
              name: takeTitle ? f.title! : p.name,
              brand: takeTitle ? (p.brand || f.brand) : p.brand,
              description: takeTitle ? (p.description || f.description) : p.description,
              imageUrl: p.imageUrl || f.imageUrl,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              vendorData: { ...((p.vendorData ?? {}) as object), ...f.attributes } as any,
            };
          });
          const originalById = new Map(products.map((p) => [p.id, p]));
          // Chunk size 5, not the default 10: the default equals the pg pool's
          // max, and a write burst that owns every connection starves the
          // status polls running concurrently on this same instance.
          await inChunks([...fills.keys()], (productId) => {
            const merged = originalById.get(productId);
            return prisma.product.update({
              where: { id: productId },
              data: {
                ...(merged?.imageUrl ? { imageUrl: merged.imageUrl } : {}),
                ...(merged && renamedIds.has(productId)
                  ? {
                      name: merged.name,
                      ...(merged.brand ? { brand: merged.brand } : {}),
                      ...(merged.description ? { description: merged.description } : {}),
                    }
                  : {}),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                vendorData: (merged?.vendorData ?? undefined) as any,
              },
            });
          }, 5);
          console.log(
            `[export] catalog back-fill: images/attributes added for ${fills.size} products` +
              (renamedIds.size ? `, ${renamedIds.size} SKU-code names resolved to real titles` : ""),
          );
        }
      } catch (err) {
        console.warn("[export] catalog back-fill failed (continuing without):", err);
      }

      // For Walmart exports: AI-generate optimised titles (meaning + attributes + USPs)
      // instead of copying vendor titles word-for-word. Falls back to vendor name on error.
      if (mpLower === "walmart" && products.length > 0) {
        try {
          await setJobPhase(jobId, `Generating optimised titles for ${products.length} products…`);
          const { generateMarketplaceTitles } = await import("@/lib/ai/generate-title");
          // Per-batch progress: a 7k catalog makes ~470 title batches, and a
          // single static phase for all of them reads as a stalled export to
          // the client's 5-minute no-progress detector.
          const titleMap = await generateMarketplaceTitles("walmart", products, (done, total) => {
            void setJobPhase(jobId, `Generating optimised titles ${done}/${total}…`);
          });
          if (titleMap.size > 0) {
            products = products.map((p) =>
              titleMap.has(p.id) ? { ...p, name: titleMap.get(p.id)! } : p
            );
          }
        } catch (err) {
          console.warn("[export] title generation failed, using vendor names:", err);
        }
      }

      // ── Disambiguate identical titles ─────────────────────────────────────
      // Vendor sheets carry genuine variants under one name: this catalog has
      // 11 rows of "Caroline's Treasures Peacock Throw Pillow…", each a
      // different artwork/size with its own UPC. Exported as-is they read as
      // one product repeated with contradictory UPCs. Each duplicate gets a
      // distinguishing suffix — its size when sizes differ, otherwise the
      // design code from its SKU — so every row is identifiable.
      {
        const byName = new Map<string, typeof products>();
        for (const p of products) {
          const k = (p.name ?? "").trim().toLowerCase();
          if (!k) continue;
          const arr = byName.get(k);
          if (arr) arr.push(p); else byName.set(k, [p]);
        }
        const suffixFor = (p: (typeof products)[number], sizesDiffer: boolean): string => {
          const vd = (p.vendorData ?? {}) as Record<string, unknown>;
          const dims = String(vd.dimensions ?? "").trim();
          if (sizesDiffer && dims) return dims;
          // Design code: the trailing alphanumeric run of the SKU
          // (CTTS-DAC3248PW1818 → DAC3248PW1818) names the variant precisely.
          const m = (p.vendorSku ?? "").match(/([A-Z0-9]{4,})$/i);
          return m ? m[1] : (p.upc ?? "").slice(-6);
        };
        let disambiguated = 0;
        for (const group of byName.values()) {
          if (group.length < 2) continue;
          const dims = new Set(group.map((p) => String(((p.vendorData ?? {}) as Record<string, unknown>).dimensions ?? "")));
          const sizesDiffer = dims.size > 1;
          for (const p of group) {
            const suffix = suffixFor(p, sizesDiffer);
            if (suffix && !p.name.toLowerCase().includes(suffix.toLowerCase())) {
              p.name = `${p.name} - ${suffix}`;
              disambiguated++;
            }
          }
        }
        if (disambiguated) {
          console.log(`[export] disambiguated ${disambiguated} identical titles with size/design suffixes`);
        }
      }

      // Mathis requires templates (throws if none). Walmart, Best Buy and Temu gracefully
      // fall back to flat category ZIP when no templates are uploaded.
      const usesTemplates = mpLower === "mathis";
      if (usesTemplates && !allTemplates.length) {
        throw new Error(`No templates found for ${projectMeta.marketplace}. Upload templates first.`);
      }

      const isTemu = mpLower === "temu";
      const isBestBuy = mpLower === "bestbuy";
      const isWalmart = mpLower === "walmart";
      const isSears = mpLower === "sears";
      const isWayfair = mpLower === "wayfair";
      // Category-split marketplaces: products grouped by category, each group filled into
      // the closest matching uploaded template (one output file per template).
      // Wayfair is category-split too, but by Wayfair *class* — the 1,305 PL SKUs span
      // multiple classes, each needing its own class-specific template workbook. The
      // per-class template fill uses a Wayfair-aware header profile (7 header rows,
      // data at row 8) inside fillTemplateXlsx — see WAYFAIR_HEADER_PROFILE in zip.ts.
      const usesCategoryExport = isTemu || isBestBuy || isWalmart || isWayfair;

      await setJobPhase(jobId, "Building spreadsheet files…");

      // Wayfair's class templates have a 7-row header block (data starts row 8) plus a
      // hidden validation engine — the shared fillTemplateXlsx would corrupt them. The
      // dedicated Wayfair filler (wayfair-fill.ts) is not enabled yet, so guard any
      // template-based Wayfair export rather than silently producing a broken workbook.
      // The no-template flat export below is safe (standard flat columns).
      if (isWayfair && ((useTemplateIds && allTemplates.length) || allTemplates.length)) {
        throw new Error(
          "Wayfair template export is not enabled yet. The dedicated Wayfair class-template " +
          "filler requires Wayfair's real Product Addition Template workbook and per-class " +
          "attribute schemas (see src/lib/export/wayfair-fill.ts). Export without a template " +
          "to produce a flat column file in the meantime.",
        );
      }

      let zipBuffer: Buffer;
      let missingTemplateCategories: string[] = [];
      // Required columns this run shipped empty. Measured during the fill and
      // kept, so the export screen can offer to set a default for each instead
      // of the gap living only in a server log.
      let unfilledColumns: { label: string; rows: number }[] = [];
      // Whether the AI could be reached at all. An empty required cell means
      // two very different things depending on this: "nothing can answer this
      // column" (offer a default) or "the AI had no credit so nothing tried"
      // (fix the balance, do NOT invent a fixed value for a per-product field).
      // Probed once per export; the balance snapshot is cached and free.
      const aiUnavailable = !(await checkAiAvailable()).ok;
      if (aiUnavailable) {
        console.warn("[export] AI is unavailable — AI-fillable cells will ship empty for this run");
      }
      if (useTemplateIds && allTemplates.length) {
        // User explicitly selected a template → all products in one file using that template.
        // This takes priority over category-split so any marketplace can use
        // a manually chosen template instead of auto-matching by category.
        const tpl = allTemplates[0];
        const templateFileData = tpl?.fileData ? Buffer.from(tpl.fileData as unknown as ArrayBuffer) : null;
        zipBuffer = await generateSingleTemplateExport(products, tpl, projectMeta.marketplace, templateFileData) as Buffer;
      } else if (isBestBuy) {
        // ── Best Buy: uploaded templates win per CATEGORY, Mirakl fills the rest ──
        //
        // Best Buy publishes no template file to download in bulk — a seller
        // fetches one category's workbook at a time from the portal. So a
        // project is normally PART covered, and stays that way for a while:
        // export, see which categories came out, fetch and upload those
        // templates, re-run, repeat.
        //
        // Serving that needs both paths in one run. Sending everything through
        // the template path name-matches the uncovered categories onto whatever
        // workbook scores highest, filling the wrong columns silently; sending
        // everything through the generated path throws away the real templates
        // that were just uploaded. So the catalogue is split and both run.
        const split = splitBestBuyByTemplate(products, allTemplates);
        console.log(
          `[export] Best Buy: ${split.coveredCategories.length} categor(y/ies) have an uploaded ` +
            `template (${split.covered.length} products), ${split.uncoveredCategories.length} do not ` +
            `(${split.uncovered.length} products)`,
        );

        const parts: Buffer[] = [];

        if (split.covered.length) {
          await setJobPhase(jobId, "Filling uploaded Best Buy templates…");
          const result = await generateCategoryZip(
            split.covered,
            allTemplates,
            projectMeta.marketplace,
            templateId,
            projectMeta.teamId,
          );
          parts.push(result.zip);
          missingTemplateCategories = result.missingTemplateCategories;
          unfilledColumns = unfilledByColumn(result.complianceIssues);
        }

        if (split.uncovered.length) {
          if (miraklConfigured()) {
            // Rebuilt from Mirakl's own attribute set, so a category with no
            // uploaded template still ships a correctly shaped sheet rather
            // than being dropped from the export.
            await setJobPhase(jobId, "Building sheets for categories with no template…");
            const columnsByCategory = await getBestBuyColumnsForCategories(split.uncoveredCategories);
            const result = await generateBestBuyCategoryZip(split.uncovered, columnsByCategory);
            parts.push(result.zip);
            // Categories Mirakl had no attribute set for fell back to flat
            // columns — surfaced the same way a missing template is.
            missingTemplateCategories = [
              ...missingTemplateCategories,
              ...result.categoriesWithoutSchema,
            ];
          } else {
            await setJobPhase(jobId, "Building spreadsheet files…");
            parts.push((await generateFlatCategoryZip(split.uncovered, projectMeta.marketplace)) as Buffer);
          }
        }

        zipBuffer = parts.length ? await mergeZips(parts) : Buffer.alloc(0);
      } else if (usesCategoryExport && allTemplates.length) {
        // With uploaded templates: match each category to the closest template
        // and export in that template's column format — one file per matched category
        const result = await generateCategoryZip(products, allTemplates, projectMeta.marketplace, templateId, projectMeta.teamId);
        zipBuffer = result.zip;
        missingTemplateCategories = result.missingTemplateCategories;
        unfilledColumns = unfilledByColumn(result.complianceIssues);
      } else if (usesCategoryExport) {
        // Without templates: split by AI-assigned category using flat columns
        zipBuffer = await generateFlatCategoryZip(products, projectMeta.marketplace) as Buffer;
      } else if (isSears && allTemplates.length) {
        // Sears uses one generic template — all products go into a single file.
        // No category-splitting needed since a single template covers the whole catalogue.
        const tpl = allTemplates[0];
        const templateFileData = tpl?.fileData ? Buffer.from(tpl.fileData as unknown as ArrayBuffer) : null;
        zipBuffer = await generateSingleTemplateExport(products, tpl, projectMeta.marketplace, templateFileData) as Buffer;
      } else if (!allTemplates.length) {
        // No templates → flat export (one file, standard columns)
        zipBuffer = await generateFlatExport(products, projectMeta.marketplace) as Buffer;
      } else if (useAutoMatch) {
        const result = await generateCategoryZip(products, allTemplates, projectMeta.marketplace, templateId, projectMeta.teamId);
        zipBuffer = result.zip;
        missingTemplateCategories = result.missingTemplateCategories;
        unfilledColumns = unfilledByColumn(result.complianceIssues);
      } else {
        zipBuffer = await generateExportZip(products, allTemplates as unknown as ExportTemplate[], projectMeta.marketplace) as Buffer;
      }

      if (sliceGroups) {
        // Keep what this slice produced and stop. The files are written before
        // the job is marked anything, so an invocation killed at the ceiling
        // still leaves finished work for the next request to build on.
        const JSZip = (await import("jszip")).default;
        const produced = await JSZip.loadAsync(zipBuffer as Buffer);
        const files: { name: string; data: Buffer }[] = [];
        for (const [name, entry] of Object.entries(produced.files)) {
          if (entry.dir) continue;
          files.push({ name, data: await entry.async("nodebuffer") });
        }
        await saveJobFiles(jobId, files);
        await markGroupsDone(jobId, sliceGroups);
        sliceMissing.push(...missingTemplateCategories);
        sliceUnfilled.push(...unfilledColumns);
        sliceAiDown = sliceAiDown || aiUnavailable;
        return;
      }

      // A one-file export (Walmart always produces a single sheet) is delivered
      // as that spreadsheet rather than a ZIP the user has to unpack first.
      const payload = await unwrapSingleFileZip(zipBuffer as Buffer);
      // Status write BEFORE resolveJob, and best-effort: it used to run after,
      // unguarded, so a transient DB error on this bookkeeping write threw the
      // job into the catch below — which discarded an already-built ZIP and
      // reported the export as failed.
      await prisma.project.update({ where: { id }, data: { status: "done" } }).catch(() => {});
      await resolveJob(jobId, payload.buffer, {
        extension: payload.extension,
        contentType: payload.contentType,
        missingTemplateCategories,
        unfilledRequired: { columns: unfilledColumns, aiUnavailable, recorded: true },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[export] export job failed:", msg);
      await rejectJob(jobId, msg);
      await prisma.project.update({ where: { id }, data: { status: "categorized" } }).catch(() => {});
      throw err;
    } finally {
      // The heartbeat must stop with the job — touchJob is a no-op once the
      // job leaves "processing", but the interval itself would leak forever.
      clearInterval(heartbeat);
    }
  };

  // ── One shot, or one slice at a time ─────────────────────────────────────
  //
  // A single invocation is capped at maxDuration. A 4,811-product Mathis
  // catalogue does not fit, and every attempt used to be killed at the ceiling
  // having thrown away everything it wrote — five identical failures at 4.7
  // minutes, each starting from nothing. So an export that produces more than
  // one file is now built group by group: each finished file is stored as it is
  // written, and the client calls back to continue.
  //
  // Nothing is re-spent on the way. Values the AI or a catalog lookup resolved
  // are already persisted per product, so a later slice reads them instead of
  // asking again.
  if (!continuing && plan.length <= 1) {
    // One file — it fits, and the client keeps polling as it always has.
    after(async () => {
      await runJob(null).catch(() => {});
    });
    return NextResponse.json({ jobId, mode: "background" });
  }

  const started = Date.now();
  let pending = continuing ? existingPending : plan;
  if (!continuing) await setJobPlan(jobId, plan);

  // At least one group per request, then as many more as the budget allows.
  while (pending.length > 0) {
    const group = pending[0];
    await runJob([group]);
    pending = pending.filter((g) => g !== group);
    if (Date.now() - started > SLICE_BUDGET_MS) break;
  }

  if (pending.length === 0) {
    const zip = await assembleJobZip(jobId);
    const payload = await unwrapSingleFileZip(zip);
    await prisma.project.update({ where: { id }, data: { status: "done" } }).catch(() => {});
    await resolveJob(jobId, payload.buffer, {
      extension: payload.extension,
      contentType: payload.contentType,
      missingTemplateCategories: [...new Set(sliceMissing)],
      unfilledRequired: {
        columns: mergeUnfilled(sliceUnfilled),
        aiUnavailable: sliceAiDown,
        recorded: true,
      },
    });
  }

  return NextResponse.json({
    jobId,
    mode: "sliced",
    done: pending.length === 0,
    remaining: pending.length,
    total: totalGroups,
  });
}

/** Worst count per column across the slices that reported it. */
function mergeUnfilled(all: { label: string; rows: number }[]): { label: string; rows: number }[] {
  const byLabel = new Map<string, number>();
  for (const c of all) byLabel.set(c.label, (byLabel.get(c.label) ?? 0) + c.rows);
  return [...byLabel].sort((a, b) => b[1] - a[1]).map(([label, rows]) => ({ label, rows }));
}
