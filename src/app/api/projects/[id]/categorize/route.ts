import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { authGuard } from "@/lib/auth-helpers";
import { prisma, inChunks } from "@/lib/db";
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
    const category = (cols[catIdx] ?? "").trim();
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
    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        products: {
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
        },
      },
    });
    if (!project) throw new Error("Project not found");

    // Temu & Best Buy share temu_categories.csv; Mathis uses mathis_categories.csv.
    // These CSV taxonomy sheets drive categorization inside categorizeProducts (not template names).
    // The top level of each assigned path still fuzzy-matches export templates at export time.
    const mpLower = project.marketplace.toLowerCase();

    setCategorizeJobPhase(jobId, `Categorizing ${project.products.length} products…`);

    // Build ProductInput with vendor category hint + supplemental context fields
    let productInputs: ProductInput[] = project.products.map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      description: p.description,
      sku: p.vendorSku,
      vendorCategory: extractVendorCategory(p.vendorData),
      vendorContext: extractVendorContext(p.vendorData),
    }));

    // ── Walmart's own category, harvested during verification ──────────────────
    // When a product was matched to a real Walmart listing, that listing carries
    // Walmart's category path — the authoritative answer for a Walmart export,
    // and far more specific than a model guess ("Home Improvement > Paint >
    // Paint Supplies & Tools > Putty Knives" vs "Tools"). Using it costs nothing
    // (already fetched and stored) and removes the product from the AI queue.
    //
    // "UNNAV" is Walmart's placeholder for items with no navigable category, so
    // it is not a usable answer and those products fall through to the AI.
    //
    // Walmart's taxonomy is authoritative for a Walmart export, but its own
    // filing is not always right: measured on a real 7k catalog, 13% of Bon
    // masonry tools sat under a non-tool top level — a concrete "Animal Track
    // Stamp" under Arts & Crafts > Scrapbooking, a masonry "Lewis Pin" under
    // Auto Parts, a texture stamp under Home > Rugs > Doormats (because the
    // name contains "Mat"). Those are Walmart's errors riding along with an
    // otherwise correct product match.
    //
    // So a path is only taken when it is plausible for the product, and
    // implausible ones fall through to the AI instead of being accepted
    // silently. `implausibleWalmartCategory` holds that judgement.
    const walmartCategoryById = new Map<string, { category: string; path: string }>();
    let walmartRejected = 0;
    if (mpLower === "walmart") {
      for (const p of project.products) {
        const parsed = parseWalmartCategoryPath(
          (p.liveData as Record<string, unknown> | null)?.categoryPath,
        );
        if (!parsed) continue;
        if (implausibleWalmartCategory(p.name, parsed.path)) { walmartRejected++; continue; }
        walmartCategoryById.set(p.id, parsed);
      }
      if (walmartRejected) {
        console.log(
          `[categorize] rejected ${walmartRejected} Walmart categories as implausible ` +
            `for the product — those fall through to the AI`,
        );
      }
    }

    // Reuse existing categories for repeatable re-runs: unless `force`, only send
    // products that don't yet have a confident category (null or "Uncategorized").
    // Already-categorized products are left untouched, so their result never changes.
    const existingCatById = new Map(project.products.map((p) => [p.id, p.marketplaceCategory]));
    const needsCategorization = (id: string) => {
      if (force) return true;
      const cat = existingCatById.get(id);
      return !cat || cat === "Uncategorized";
    };
    productInputs = productInputs.filter((p) => needsCategorization(p.id));

    // Apply Walmart's own categories first. These are authoritative for a
    // Walmart export, so they are written straight through and skip the AI
    // entirely — which also makes the run faster the more products verified
    // successfully.
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
          const vendorDataById = new Map(
            project.products.map((p) => [p.id, (p.vendorData ?? {}) as Record<string, unknown>]),
          );
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
        project.marketplace,
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

    // Walmart new-listing: the listing template requires a "Spec Product Type"
    // (from Walmart's PT taxonomy) that categorization doesn't produce. Assign it
    // here so col E can be filled at export. Degrades to a no-op when the Seller
    // API / taxonomy is unavailable — the field is simply left blank.
    if (mpLower === "walmart" && project.isNewListing && productInputs.length > 0) {
      try {
        setCategorizeJobPhase(jobId, "Assigning Walmart spec product types…");
        const { assignSpecProductTypes } = await import("@/lib/ai/walmart-spec-product-type");
        const specInputs = productInputs.map((p) => ({
          id: p.id,
          name: p.name,
          brand: p.brand,
          description: p.description,
          category: existingCatById.get(p.id) ?? null,
        }));
        const specMap = await assignSpecProductTypes(specInputs);
        if (specMap.size > 0) {
          await inChunks([...specMap], ([productId, specProductType]) =>
            prisma.product.update({ where: { id: productId }, data: { specProductType } }),
          );
        }
      } catch (err) {
        console.warn("[categorize] spec product-type assignment failed:", err);
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
