import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { authGuard } from "@/lib/auth-helpers";
import { prisma, inChunks } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { categorizeProducts, type ProductInput } from "@/lib/ai/categorize";
import { enrichSkuOnlyProducts, looksLikeSkuName } from "@/lib/ai/resolve-sku";
import {
  createCategorizeJob,
  setCategorizeJobPhase,
  resolveCategorizeJob,
  rejectCategorizeJob,
  getCategorizeJob,
} from "@/lib/categorize/job-store";
import { preCategorizeStatus } from "@/lib/projects/marketplace-flow";
import {
  implausibleWalmartCategory,
  parseWalmartCategoryPath,
} from "@/lib/categorize/walmart-category";
import {
  loadWalmartRichTaxonomy,
  loadWalmartProductTypes,
} from "@/lib/ai/walmart-taxonomy";

// ── PUT /api/projects/[id]/categorize ─────────────────────────────────────────
// Import categories from a CSV file. Expected columns: SKU (or name), Category, [Category Path].
// Matches rows to products by SKU → vendorSku exact match, then by normalized name.
// Useful for the workflow: AI categorize → download CSV → verify/edit → re-upload.

/** Rows per bulk statement. Keeps the parameter count well under Postgres' 65535 cap. */
const CATEGORY_WRITE_CHUNK = 500;

/**
 * Write categorization verdicts with one statement per chunk instead of one
 * round-trip per product.
 *
 * Prisma has no bulk-update-with-distinct-values primitive (`updateMany` applies
 * a single identical payload), so this builds an UPDATE ... FROM (VALUES ...).
 * Values are passed as query parameters, never interpolated.
 *
 * The database is remote — a round-trip measures ~280ms from here — so 7k
 * per-row updates at 10 concurrent cost minutes of pure network wait after the
 * AI work is already finished. That was the "Saving results …" tail at the end
 * of a run.
 */
async function bulkUpdateCategories(
  rows: Array<{ productId: string; category: string; path: string; confidence: number }>,
  onProgress?: (saved: number, total: number) => void,
): Promise<void> {
  if (!rows.length) return;
  let saved = 0;
  for (let i = 0; i < rows.length; i += CATEGORY_WRITE_CHUNK) {
    const chunk = rows.slice(i, i + CATEGORY_WRITE_CHUNK);
    const params: unknown[] = [];
    const tuples: string[] = [];
    for (const r of chunk) {
      const n = params.length;
      params.push(r.productId, r.category, r.path, r.confidence);
      tuples.push(`($${n + 1}::text, $${n + 2}::text, $${n + 3}::text, $${n + 4}::double precision)`);
    }
    params.push(new Date());
    await prisma.$executeRawUnsafe(
      `UPDATE "Product" AS p
       SET "marketplaceCategory" = v.category,
           "categoryPath"        = v.path,
           "categoryConfidence"  = v.confidence,
           "categorizedAt"       = $${params.length}::timestamp
       FROM (VALUES ${tuples.join(",")}) AS v(id, category, path, confidence)
       WHERE p.id = v.id`,
      ...params,
    );
    saved += chunk.length;
    onProgress?.(saved, rows.length);
  }
}

// ── GET /api/projects/[id]/categorize?jobId=… ─────────────────────────────────
// Poll a background categorization job started by POST. Returns the current
// phase while running, the summary once done, or the error message on failure.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { response } = await authGuard();
  if (response) return response;
  await params; // id not needed — the jobId is unique per run

  const jobId = req.nextUrl.searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  const job = getCategorizeJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found or expired" }, { status: 404 });

  if (job.status === "processing") {
    return NextResponse.json({
      status: "processing",
      phase: job.phase ?? "Preparing…",
      updatedAt: job.updatedAt,
    });
  }
  if (job.status === "error") {
    return NextResponse.json({ status: "error", error: job.error }, { status: 500 });
  }
  return NextResponse.json({ status: "done", ...job.result });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, userId: true, products: { select: { id: true, name: true, vendorSku: true } } },
  });
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let form: FormData;
  try { form = await req.formData(); } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file attached" }, { status: 400 });

  const raw = Buffer.from(await file.arrayBuffer()).toString("utf-8").replace(/^﻿/, "");
  const delim = raw.includes("\t") ? "\t" : ",";
  const [headerLine, ...dataLines] = raw.split(/\r?\n/).filter(Boolean);
  const headers = (headerLine ?? "").split(delim).map(h => h.replace(/^"|"$/g, "").trim().toLowerCase());

  // Find column indices
  const skuIdx = headers.findIndex(h => /sku|sku_id|vendor_sku|item_sku/.test(h));
  const nameIdx = headers.findIndex(h => /product[\s_]?name|name|title/.test(h));
  const catIdx = headers.findIndex(h => /^category$|marketplace[\s_]?cat/.test(h));
  const ptIdx = headers.findIndex(h => /^product[\s_]?type$/.test(h));
  const pathIdx = headers.findIndex(h => /category[\s_]?path|path/.test(h));

  if (catIdx === -1) {
    return NextResponse.json({ error: "CSV must have a 'Category' column" }, { status: 400 });
  }

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const skuMap = new Map(project.products.map(p => [p.vendorSku?.trim() ?? "", p.id]));
  const nameMap = new Map(project.products.map(p => [norm(p.name), p.id]));

  const updates: Array<{ id: string; category: string; path: string | null }> = [];
  for (const line of dataLines) {
    if (!line.trim()) continue;
    const cols = line.split(delim).map(c => c.replace(/^"|"$/g, "").trim());
    const sku = skuIdx >= 0 ? (cols[skuIdx] ?? "") : "";
    const name = nameIdx >= 0 ? (cols[nameIdx] ?? "") : "";
    let category = (cols[catIdx] ?? "").trim();
    const productType = ptIdx >= 0 ? (cols[ptIdx] ?? "").trim() : "";
    // The downloaded CSV splits "Category > Product Type" into two columns;
    // re-join here so download -> edit -> upload round-trips are lossless.
    // Skip when the category cell already carries a full path (older files).
    if (productType && !category.includes(" > ")) category = `${category} > ${productType}`;
    const path = pathIdx >= 0 ? (cols[pathIdx] ?? "").trim() || null : null;
    if (!category) continue;

    const productId = (sku && skuMap.get(sku)) || (name && nameMap.get(norm(name)));
    if (!productId) continue;
    updates.push({ id: productId, category, path });
  }

  if (!updates.length) {
    return NextResponse.json({ error: "No matching products found in CSV" }, { status: 400 });
  }

  // Chunked — a large CSV import would otherwise exhaust the pg pool.
  await inChunks(updates, (u) =>
    prisma.product.update({
      where: { id: u.id },
      data: { marketplaceCategory: u.category, categoryPath: u.path, categorizedAt: new Date() },
    })
  );
  await prisma.project.update({ where: { id }, data: { status: "categorized" } });

  return NextResponse.json({ updated: updates.length, total: project.products.length });
}

// Keys we try (in order) when extracting the vendor's own category from raw spreadsheet data.
const VENDOR_CATEGORY_KEYS = [
  "category", "Category", "CATEGORY",
  "product_category", "item_category", "item_type", "product_type",
  "department", "Department", "sub_category", "subcategory",
  "product_class", "product_group", "item_group",
];

// Additional vendor fields that provide strong categorization signals.
// These are extracted and included as supplemental context in the AI prompt.
const VENDOR_CONTEXT_KEYS = [
  // Product type / classification
  "item_type", "product_type", "type", "style", "product_style",
  // Age / audience
  "age_group", "age", "target_age", "age_range", "audience",
  // Gender
  "gender", "target_gender", "sex",
  // Size signals
  "size", "size_range", "sizes", "available_sizes",
  // Season / occasion
  "season", "occasion", "holiday", "theme",
  // Material / fabric (useful for furniture vs soft goods)
  "material", "fabric", "composition",
  // Color (helps distinguish furniture line vs costume)
  "color", "colour",
];

function extractVendorCategory(vendorData: unknown): string | null {
  if (!vendorData || typeof vendorData !== "object") return null;
  const vd = vendorData as Record<string, unknown>;
  for (const key of VENDOR_CATEGORY_KEYS) {
    const val = vd[key];
    if (val && typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

// Build a short "key: value" context string from vendor data fields that help
// the AI distinguish between categories (e.g. age_group=Toddler, season=Halloween).
// Skips URLs, empty values, and very long strings to keep the prompt tight.
function extractVendorContext(vendorData: unknown): string | null {
  if (!vendorData || typeof vendorData !== "object") return null;
  const vd = vendorData as Record<string, unknown>;
  const nk = (s: string) => s.toLowerCase().replace(/[\s_\-]+/g, "_");
  const parts: string[] = [];

  for (const key of VENDOR_CONTEXT_KEYS) {
    // Try exact key and case-insensitive normalized match
    let val: unknown = vd[key];
    if (val === undefined || val === null || val === "") {
      const found = Object.entries(vd).find(([k]) => nk(k) === nk(key));
      val = found?.[1];
    }
    if (!val || typeof val !== "string") continue;
    const v = val.trim();
    if (!v || v.length > 80 || v.startsWith("http")) continue;
    parts.push(`${key}: ${v}`);
    if (parts.length >= 6) break; // cap to keep prompt size reasonable
  }

  return parts.length ? parts.join(", ") : null;
}

// Start a background categorization job — lightweight auth + existence check only,
// then returns { jobId } immediately. All heavy work (loading every product, the
// dozens of model round-trips) runs in the background closure so a several-thousand
// product run is never bound by the 300 s HTTP request limit; the client polls GET.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  // `force: true` re-categorizes every product from scratch. Default (false) reuses
  // each product's existing category and only (re)processes ones that are still
  // Uncategorized / never categorized — so repeat runs give stable, repeatable results.
  const body = await req.json().catch(() => ({}));
  const force: boolean = body?.force === true;

  // Lightweight check — ownership only, no heavy product data loaded yet.
  const projectMeta = await prisma.project.findUnique({
    where: { id },
    select: { id: true, userId: true, marketplace: true },
  });
  if (!projectMeta) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (projectMeta.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const jobId = `${id}_${Date.now()}`;
  const startedAt = Date.now();
  createCategorizeJob(jobId);
  // Clear prior timing on start — each categorize run is a full re-run.
  await prisma.project.update({
    where: { id },
    data: { status: "categorizing", categorizeMs: 0, categorizeCompletedAt: null },
  });

  // Heavy work runs here; the HTTP response returns the jobId below.
  void (async () => {
   try {
    // Temu & Best Buy share temu_categories.csv; Mathis uses mathis_categories.csv.
    // These CSV taxonomy sheets drive categorization inside categorizeProducts (not template names).
    // The top level of each assigned path still fuzzy-matches export templates at export time.
    const mpLower = projectMeta.marketplace.toLowerCase();

    const totalCount = await prisma.product.count({ where: { projectId: id } });
    setCategorizeJobPhase(jobId, `Categorizing ${totalCount} products…`);

    // Never load the whole catalog in one SELECT: each row drags its raw
    // vendorData and liveData JSON blobs along — at 10k+ products that is
    // 100+ MB held for the whole run, enough to OOM the 512 MB production
    // instance. Instead, stream id-ordered pages and keep only the slim,
    // extracted values every later step actually works from; the blobs are
    // released with each page.
    const PAGE_SIZE = 500;

    // Build ProductInput with vendor category hint + supplemental context fields
    const productInputsAll: ProductInput[] = [];

    // ── Walmart live-listing data, harvested during verification ───────────────
    // When a product was matched to a real Walmart listing, that listing carries
    // a category breadcrumb (`liveData.categoryPath`) and — when the Seller API
    // was the match source — a productType. Both are validated against Walmart's
    // item taxonomy before they are trusted:
    //
    //   - The breadcrumb is Walmart.com SITE NAVIGATION ("Home Page/Home/Decor/
    //     Shop All Wall Sconces"), not a seller item-taxonomy entry. Measured on
    //     a real project, 45/49 breadcrumbs were navigation labels that exist
    //     nowhere in the taxonomy — writing them through verbatim is what put
    //     invented-looking values like "Shop All Wall Sconces" in exports. So a
    //     breadcrumb is accepted ONLY when it exactly matches one of the
    //     taxonomy's "Category > Product Type Group" paths (and is stored in the
    //     taxonomy's own casing); otherwise the product goes to the AI with the
    //     breadcrumb attached as a hint — evidence, not an answer.
    //
    //   - Even an exact taxonomy match can be Walmart's own misfiling (a masonry
    //     "Lewis Pin" under Auto Parts, an "Animal Track Stamp" under
    //     Scrapbooking — keyword-driven errors measured at ~13% on a 7k
    //     trade-tool catalog), so `implausibleWalmartCategory` still applies.
    //
    //   - "UNNAV" is Walmart's placeholder for items with no navigable category;
    //     parseWalmartCategoryPath already rejects it.
    const walmartCategoryById = new Map<string, { category: string; path: string }>();
    // Spec Product Type from the Seller API live data — the exact value Walmart
    // has on file for that listing. More reliable than AI assignment, so it is
    // persisted directly (once validated) and those products skip the AI spec
    // pass below.
    const walmartSpecTypeById = new Map<string, string>();
    // Existing category per product — drives repeatable re-runs and the final counts.
    const existingCatById = new Map<string, string | null>();
    let walmartRejected = 0;
    let walmartSpecRejected = 0;

    // Canonical taxonomy lookups: normalized value → verbatim taxonomy value.
    const normTax = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const walmartPathByNorm = new Map<string, string>();
    const walmartSpecByNorm = new Map<string, string>();
    if (mpLower === "walmart") {
      for (const path of loadWalmartRichTaxonomy() ?? []) walmartPathByNorm.set(normTax(path), path);
      for (const t of loadWalmartProductTypes() ?? []) walmartSpecByNorm.set(normTax(t), t);
    }

    {
      let cursor: string | null = null;
      for (;;) {
        const where: Prisma.ProductWhereInput = cursor
          ? { projectId: id, id: { gt: cursor } }
          : { projectId: id };
        const page = await prisma.product.findMany({
          where,
          orderBy: { id: "asc" },
          take: PAGE_SIZE,
          select: {
            id: true,
            name: true,
            brand: true,
            description: true,
            vendorSku: true,
            marketplaceCategory: true,
            vendorData: true,
            // Verification stores the matched marketplace listing here, which
            // includes Walmart's own category path for the product.
            liveData: true,
          },
        });
        if (page.length === 0) break;
        cursor = page[page.length - 1].id;

        for (const p of page) {
          existingCatById.set(p.id, p.marketplaceCategory);

          // Walmart live-listing data — parsed BEFORE the AI input is built so
          // a rejected breadcrumb can ride along as a hint for the model.
          let breadcrumbHint: string | null = null;
          if (mpLower === "walmart") {
            const ld = p.liveData as Record<string, unknown> | null;
            // productType is present when the Seller API was the match source.
            // Independent of the breadcrumb; stored only when it's a real
            // taxonomy value (accepted as-is if the local list is unavailable).
            const pt = typeof ld?.productType === "string" ? ld.productType.trim() : null;
            if (pt) {
              const canonical = walmartSpecByNorm.size ? walmartSpecByNorm.get(normTax(pt)) : pt;
              if (canonical) walmartSpecTypeById.set(p.id, canonical);
              else walmartSpecRejected++;
            }
            const parsed = parseWalmartCategoryPath(ld?.categoryPath);
            if (parsed) {
              const canonicalPath = walmartPathByNorm.get(normTax(parsed.path));
              if (canonicalPath && !implausibleWalmartCategory(p.name, canonicalPath)) {
                walmartCategoryById.set(p.id, {
                  category: canonicalPath.split(" > ").pop() ?? canonicalPath,
                  path: canonicalPath,
                });
              } else {
                // Site-navigation breadcrumb (or a misfiled listing) — not a
                // taxonomy value. Hand the AI the evidence instead.
                walmartRejected++;
                breadcrumbHint = parsed.path;
              }
            }
          }

          // Reuse existing categories for repeatable re-runs: unless `force`,
          // only send products that don't yet have a confident category (null
          // or "Uncategorized"). Already-categorized products are left
          // untouched, so their result never changes.
          if (force || !p.marketplaceCategory || p.marketplaceCategory === "Uncategorized") {
            productInputsAll.push({
              id: p.id,
              name: p.name,
              brand: p.brand,
              description: p.description,
              sku: p.vendorSku,
              vendorCategory: extractVendorCategory(p.vendorData),
              vendorContext: extractVendorContext(p.vendorData),
              walmartBreadcrumb: breadcrumbHint,
            });
          }
        }
      }
    }
    if (walmartRejected || walmartSpecRejected) {
      console.log(
        `[categorize] Walmart live-data validation: ${walmartRejected} breadcrumbs ` +
          `are not item-taxonomy paths (passed to the AI as hints), ` +
          `${walmartSpecRejected} spec types rejected as off-list`,
      );
    }

    let productInputs = productInputsAll;

    // Apply Walmart's own categories first — only breadcrumbs that validated
    // as exact item-taxonomy paths above, so writing them straight through can
    // never store an off-list value. They skip the AI entirely, which also
    // makes the run faster the more products verified successfully.
    const fromWalmart = productInputs
      .filter((p) => walmartCategoryById.has(p.id))
      .map((p) => {
        const w = walmartCategoryById.get(p.id)!;
        return { productId: p.id, category: w.category, path: w.path, confidence: 1 };
      });
    if (fromWalmart.length) {
      setCategorizeJobPhase(jobId, `Applying Walmart categories to ${fromWalmart.length} products…`);
      await bulkUpdateCategories(fromWalmart);
      for (const r of fromWalmart) existingCatById.set(r.productId, r.category);
      productInputs = productInputs.filter((p) => !walmartCategoryById.has(p.id));
      console.log(
        `[categorize] ${fromWalmart.length} products took Walmart's own category; ` +
          `${productInputs.length} left for the AI`,
      );
    }

    // Save Spec Product Types sourced directly from the Seller API live data.
    // These are exact values Walmart already has on file — no AI needed.
    if (walmartSpecTypeById.size > 0) {
      await inChunks([...walmartSpecTypeById], ([productId, specProductType]) =>
        prisma.product.update({ where: { id: productId }, data: { specProductType } }),
      );
      console.log(
        `[categorize] ${walmartSpecTypeById.size} products got Spec Product Type from live Seller API data`,
      );
    }

    let enrichedCount = 0;

    if (productInputs.length > 0) {
      // SKU-only sheets (common for Mathis): resolve codes like TOVF-TOVL54566 → real
      // product titles (vendor catalog first, then web search) before asking Claude to
      // categorize. Enrichment is a PER-PRODUCT NETWORK CALL (Shopify catalog + product
      // page fetch), so it must run ONLY for products that actually need it — a product
      // that already has a real title has nothing to gain and would just add ~1s of
      // network latency each. Running it for all 2000 products (because they carried a
      // catalog-vendor SKU) took ~28 min and stalled the run. Trigger only when the
      // name is still a raw code.
      const skuOnly = productInputs.filter((p) => looksLikeSkuName(p.name, p.sku));
      if (skuOnly.length > 0) {
        setCategorizeJobPhase(jobId, `Resolving ${skuOnly.length} SKU-only products…`);
        const { products: enriched, enrichments } = await enrichSkuOnlyProducts(
          skuOnly,
          (done, total) => setCategorizeJobPhase(jobId, `Resolving SKU-only products ${done}/${total}…`),
        );
        // Fold the enriched rows back into the full input list by id.
        const enrichedById = new Map(enriched.map((e) => [e.id, e]));
        productInputs = productInputs.map((p) => enrichedById.get(p.id) ?? p);
        enrichedCount = enrichments.length;
        if (enrichments.length > 0) {
          // Merge catalog attributes (Size/Color/images/weight) INTO the existing
          // vendorData so the export template can fill those columns — the vendor sheet
          // itself was bare SKUs, so this is the only source for them.
          // Fetched here for just the enriched rows: the streaming load above
          // deliberately let go of the raw vendorData blobs to keep memory flat.
          const enrichedIds = enrichments.map((e) => e.productId);
          const vendorDataById = new Map<string, Record<string, unknown>>();
          for (let i = 0; i < enrichedIds.length; i += PAGE_SIZE) {
            const rows = await prisma.product.findMany({
              where: { id: { in: enrichedIds.slice(i, i + PAGE_SIZE) } },
              select: { id: true, vendorData: true },
            });
            for (const row of rows) {
              vendorDataById.set(row.id, (row.vendorData ?? {}) as Record<string, unknown>);
            }
          }
          await inChunks(enrichments, (e) => {
            const mergedVendorData = e.attributes
              ? { ...(vendorDataById.get(e.productId) ?? {}), ...e.attributes }
              : undefined;
            return prisma.product.update({
              where: { id: e.productId },
              data: {
                name: e.name,
                brand: e.brand,
                description: e.description,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ...(mergedVendorData ? { vendorData: mergedVendorData as any } : {}),
              },
            });
          });
        }
      }

      setCategorizeJobPhase(jobId, `Assigning categories to ${productInputs.length} products…`);
      const results = await categorizeProducts(
        projectMeta.marketplace,
        productInputs,
        undefined,
        // Live progress → job.updatedAt advances every wave, so the client sees a slow
        // run as alive rather than stalled. Throttled to whole-percent changes so we
        // don't rewrite the phase on every batch.
        (done, total, note) => {
          const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
          // `note` marks a refinement pass (off-list retry, web-search rescue,
          // forced-choice), which runs AFTER every product already has a result
          // and reports its own much smaller totals. Labelling those
          // "Categorizing 4/33" alongside a saturated 7,021/7,021 counter reads
          // as a stuck run, so name the pass instead.
          setCategorizeJobPhase(
            jobId,
            note
              ? `${note.charAt(0).toUpperCase()}${note.slice(1)} ${done}/${total}`
              : `Categorizing ${done}/${total} (${pct}%)…`,
          );
        },
        // Stream each wave's verdicts to the DB as soon as they land — same
        // "show finished results while the rest keeps running" pattern used for
        // verification, instead of a blank spinner for the whole (multi-minute) run.
        // These are provisional: the bulletproofing gate below may still downgrade a
        // low-confidence or unresolved-SKU result to Uncategorized once the full run
        // settles, and that corrected value overwrites this one in the final write.
        async (wave) => {
          // Bulk-write the wave rather than one round-trip per product: with a
          // remote database (~280ms RTT) and 32 waves in flight, per-row writes
          // here both slow the run and monopolise the connection pool.
          // A transient failure is not fatal — the final write below is authoritative.
          await bulkUpdateCategories(wave).catch(() => {});
        },
      );

      // ── Bulletproofing: route uncertain products to review instead of guessing ──
      // Correctness-first policy — it is always safer to mark a product "Uncategorized"
      // (excluded from export, surfaced for manual review) than to assign a wrong category.
      // Two gates:
      //   1. Unresolved SKU — the name is still a raw vendor code (catalog + web both failed),
      //      so the AI had nothing real to categorize. Never trust that guess.
      //   2. Low confidence — the AI itself signalled uncertainty below the threshold.
      //
      // For constrained-taxonomy marketplaces (Temu, BestBuy, Mathis, Walmart) the AI
      // can ONLY return valid paths from a fixed list, so hallucinated names are already
      // rejected. A "nearest valid match" at moderate confidence is generally better than
      // Uncategorized — but a truly random guess at very low confidence is NOT.
      // Example: "Acid Brush" landing in "TV & Home Theater > Home Theater in a Box"
      // at confidence 0.05 should be Uncategorized, not exported in the wrong category.
      //
      // Two-tier threshold:
      //   - Non-constrained (open-ended AI categories): use MIN_CONFIDENCE (default 0.6)
      //   - Constrained (fixed CSV taxonomy): use a low floor (0.2) so legitimate
      //     niche matches (crowns, kippot, tarboosh hats at 0.25–0.3) survive while
      //     clearly wrong random guesses (tools → Home Theater at 0.05) are excluded.
      const isConstrainedTaxonomy = ["temu", "bestbuy", "sears", "mathis", "walmart"].includes(mpLower);
      const MIN_CONFIDENCE = Number(process.env.CATEGORIZE_MIN_CONFIDENCE ?? 0.6);
      const CONSTRAINED_MIN_CONFIDENCE = Number(process.env.CATEGORIZE_CONSTRAINED_MIN_CONFIDENCE ?? 0.2);
      const inputById = new Map(productInputs.map((p) => [p.id, p]));

      for (const r of results) {
        const input = inputById.get(r.productId);
        // Only treat as unresolved if the name is still a raw code AND there's no
        // description or vendor category to anchor the AI's decision on.
        const stillRawSku = input
          ? looksLikeSkuName(input.name, input.sku) && !input.description && !input.vendorCategory
          : false;
        const failsConfidence = isConstrainedTaxonomy
          ? r.confidence < CONSTRAINED_MIN_CONFIDENCE
          : r.confidence < MIN_CONFIDENCE;
        if (r.category !== "Uncategorized" && (stillRawSku || failsConfidence)) {
          r.category = "Uncategorized";
          r.path = "Uncategorized";
        }
      }

      // Bulk write. Each row gets distinct values, which Prisma cannot express
      // (`updateMany` applies ONE payload to every match), so this issues an
      // UPDATE ... FROM (VALUES ...) per chunk instead of one round-trip per row.
      //
      // This matters far more than it looks: the database is remote and a single
      // round-trip measures ~280ms from here, so 7k per-row updates at 10
      // concurrent is ~3+ minutes of pure waiting AFTER every product already
      // shows a category — the "still saving" tail at the end of a run. The same
      // fix is applied to verification's persist path for the same reason.
      await bulkUpdateCategories(results, (saved, total) =>
        setCategorizeJobPhase(jobId, `Saving results ${saved}/${total}`),
      );

      // Fold new results into the existing-category map so the response counts
      // reflect the full project (kept + newly categorized).
      for (const r of results) existingCatById.set(r.productId, r.category);
    }

    // Walmart: for products that didn't get a Spec Product Type from live Seller API
    // data, use AI to assign one from Walmart's PT taxonomy. Skip products already
    // covered above — live data is more accurate than AI inference.
    let specTypesRequested = 0;
    let specTypesAssigned = 0;
    let specTypeError: string | undefined;
    if (mpLower === "walmart") {
      // All products (including those that went through the Walmart category path)
      // need a spec type. Use all project products minus those already assigned from
      // live data. Paged back out of the DB — the streaming load above kept no
      // product rows around — into the slim inputs the spec assigner needs.
      const specInputs: Array<{
        id: string;
        name: string;
        brand: string | null;
        description: string | null;
        category: string | null;
      }> = [];
      {
        let cursor: string | null = null;
        for (;;) {
          const where: Prisma.ProductWhereInput = cursor
            ? { projectId: id, id: { gt: cursor } }
            : { projectId: id };
          const page = await prisma.product.findMany({
            where,
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
            select: { id: true, name: true, brand: true, description: true, categoryPath: true },
          });
          if (page.length === 0) break;
          cursor = page[page.length - 1].id;
          for (const p of page) {
            if (walmartSpecTypeById.has(p.id)) continue;
            specInputs.push({
              id: p.id,
              name: p.name,
              brand: p.brand,
              description: p.description,
              // The full "Category > Product Type Group" path scopes the spec
              // prompt to that group's types. The flat category leaf (fallback)
              // resolves no group, which degraded the prompt to the full ~7K
              // type list and tanked accuracy.
              category: p.categoryPath ?? existingCatById.get(p.id) ?? null,
            });
          }
        }
      }
      specTypesRequested = specInputs.length;
      if (specInputs.length > 0) {
        try {
          setCategorizeJobPhase(jobId, "Assigning Walmart spec product types…");
          const { assignSpecProductTypes } = await import("@/lib/ai/walmart-spec-product-type");
          const specMap = await assignSpecProductTypes(specInputs);
          if (specMap.size > 0) {
            await inChunks([...specMap], ([productId, specProductType]) =>
              prisma.product.update({ where: { id: productId }, data: { specProductType } }),
            );
          }
          specTypesAssigned = specMap.size;
        } catch (err) {
          // Surfaced in the job summary — a failed spec pass must not report as
          // a clean run (the export would silently fall back to category-leaf
          // values, which are usually NOT valid Walmart spec product types).
          specTypeError = err instanceof Error ? err.message : String(err);
          console.warn("[categorize] spec product-type assignment failed:", err);
        }
      }
    }

    await prisma.project.update({
      where: { id },
      data: {
        status: "categorized",
        categorizeMs: Date.now() - startedAt,
        categorizeCompletedAt: new Date(),
      },
    });

    const allCats = [...existingCatById.values()];
    const matched = allCats.filter((c) => c && c !== "Uncategorized").length;
    const unmatched = allCats.length - matched;

    resolveCategorizeJob(jobId, {
      categorized: allCats.length,
      matched,
      unmatched,
      reprocessed: productInputs.length,
      enrichedFromSku: enrichedCount,
      ...(mpLower === "walmart"
        ? { specTypesRequested, specTypesAssigned, ...(specTypeError ? { specTypeError } : {}) }
        : {}),
      categories:
        mpLower === "temu"
          ? ["(temu_categories.csv taxonomy)"]
          : mpLower === "bestbuy"
            ? ["(bestbuy_categories.csv taxonomy)"]
            : mpLower === "sears"
              ? ["(sears_categories.csv taxonomy)"]
              : mpLower === "mathis"
                ? ["(mathis_categories.csv taxonomy)"]
                : [],
    });
   } catch (err) {
    // Roll back to the step BEFORE Categorize. For skip-verify marketplaces
    // (Temu, Best Buy, …) that is "uploaded", not "verified" — otherwise a
    // failed categorization leaves a Temu project wrongly showing "Verified".
    await prisma.project
      .update({ where: { id }, data: { status: preCategorizeStatus(projectMeta.marketplace) } })
      .catch(() => {});
    const msg = err instanceof Error ? err.message : "Categorization failed";
    console.error("[categorize] background job failed:", msg);
    rejectCategorizeJob(jobId, msg);
   }
  })();

  return NextResponse.json({ jobId });
}
