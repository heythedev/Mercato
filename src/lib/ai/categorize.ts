import { generateText, type ModelMessage } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { formatTemuTaxonomyForPrompt, loadTemuCategoryPaths } from "@/lib/ai/temu-taxonomy";
import { formatMathisTaxonomyForPrompt, loadMathisCategoryPaths } from "@/lib/ai/mathis-taxonomy";
import { formatWalmartTaxonomyForPrompt, loadWalmartCategoryPaths } from "@/lib/ai/walmart-taxonomy";
import { formatBestBuyTaxonomyForPrompt, loadBestBuyCategoryPaths } from "@/lib/ai/bestbuy-taxonomy";
import { formatSearsTaxonomyForPrompt, loadSearsCategoryPaths } from "@/lib/ai/sears-taxonomy";
import { formatWayfairTaxonomyForPrompt, loadWayfairCategoryPaths, hasWayfairTaxonomy } from "@/lib/ai/wayfair-taxonomy";
import { looksLikeSkuName } from "@/lib/ai/resolve-sku";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type ProductInput = {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
  sku?: string | null;            // vendor SKU — resolution key for SKU-only sheets
  vendorCategory?: string | null;
  vendorContext?: string | null;  // additional vendor fields: age_group, gender, season, etc.
};

export type CategorizeResult = {
  productId: string;
  category: string;
  path: string;
  confidence: number;
};

// ── Web search enrichment ─────────────────────────────────────────────────────
// Uses SerpAPI (if key is set) to look up a product name and return a short
// context snippet. Called for low-confidence or Uncategorized products so the
// AI gets real-world context about what the product actually is.

async function searchProductContext(name: string): Promise<string | null> {
  const key = process.env.SERPAPI_KEY;
  if (!key) return null;
  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(name)}&engine=google&api_key=${key}&num=3`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json() as { organic_results?: { snippet?: string; title?: string }[] };
    const snippets = (data.organic_results ?? [])
      .slice(0, 3)
      .map((r) => [r.title, r.snippet].filter(Boolean).join(": "))
      .filter(Boolean)
      .join(" | ");
    return snippets || null;
  } catch {
    return null;
  }
}

// ── Category hints ────────────────────────────────────────────────────────────
// Descriptions used to build the category guide in the AI prompt.
// These are informational only — the AI makes its own decision based on
// understanding what the product actually IS.

const CATEGORY_HINTS: Array<[RegExp, string]> = [
  [/seasonal|holiday|christmas|halloween|easter|thanksgiving/i,
    "Seasonal/holiday home decor & entertaining: Christmas trees, decorations, lights, wreaths, garlands, seasonal tableware & linens, holiday blankets & throws. Subcategories by holiday: Christmas, Easter, Halloween, Thanksgiving, Hanukkah, Fourth of July, Valentines Day, Seasons."],
  [/baby|kid|youth|child|nursery|toddler/i,
    "Baby & kids home products: nursery furniture (cribs, changing tables, bassinets), kids bedroom furniture, kids playroom items (toys, play tables, stuffed animals), baby & kids decor, kids bedding, lunchtime essentials."],
  [/living\s*room|sofa|sectional|recliner|loveseat/i,
    "Living room furniture: sofas, sectionals, loveseats, recliners, accent chairs, ottomans & poufs, coffee tables, end & side tables, TV stands, fireplaces, futons, sleeper sofas."],
  [/bedroom|bed|headboard|dresser|nightstand/i,
    "Bedroom furniture: beds, headboards, dressers & chests, nightstands, armoires & wardrobes, bedroom sets, vanities, Murphy beds, benches."],
  [/dining|bar\s*stool|buffet|sideboard/i,
    "Dining room furniture: dining tables, dining chairs, dining sets, bar stools, bar & pub tables, sideboards & buffets, display & china cabinets, kitchen islands & carts."],
  [/outdoor|patio|garden/i,
    "Outdoor furniture & accessories: outdoor seating (sofas, chairs, sectionals, benches), outdoor dining, outdoor tables, fire pits, gardening (planters, garden beds, tools), outdoor accessories (rugs, cushions, lighting, grills)."],
  [/mattress|sleep|foundation|pillow/i,
    "Mattress & sleep accessories: bed in a box, mattress accessories (bed frames, bed pillows, boxsprings & foundations, duvet inserts, sheets & pillowcases)."],
  [/rug|doormat/i,
    "Rugs & floor coverings: indoor rugs, outdoor rugs, doormats, rug pads, stair treads."],
  [/bedding|bath|towel|sheet|comforter|duvet/i,
    "Bedding & bath: bed linens (comforters, duvet covers, sheets, quilts, blankets & throws), bath linens (towels, robes, bath rugs), bath accessories (mirrors, shower curtains, storage), bath furniture, bath hardware."],
  [/decor|accent|sculpture|vase|candle|mirror|frame/i,
    "Decor: accents (sculptures, vases, mirrors, picture frames, clocks, candles & holders), flowers & plants (faux/live), lighting (ceiling fans, chandeliers, lamps, sconces, pendants), wall art & decor, pillows & throws, pets, window treatments, fragrances & diffusers."],
  [/light|lamp|chandelier|sconce|fan/i,
    "Lighting (under Decor department): ceiling fans, chandeliers, desk/floor/table lamps, flush mount, pendants, sconces, vanity lights, outdoor lights, novelty lights, wall lights."],
  [/kitchen|cookware|bakeware|tabletop/i,
    "Kitchen: cookware & bakeware (pots, pans, bakeware sets), electrics (blenders, coffee makers, air fryers, mixers), kitchen furniture (bakers racks, islands & carts), kitchen tools, tabletop & bar (dinnerware, drinkware, flatware, serveware)."],
  [/office|desk|bookcase/i,
    "Office furniture (under Furniture): bookcases, desks, file cabinets, office chairs, laptop carts & stands, gaming, office sets."],
  [/storage|organiz|closet|laundry|pantry/i,
    "Organization: bathroom, closet, kitchen, garage, laundry & cleaning, office, baby & kids, outdoor, and specialty organization products."],
  [/entry|hall\s*tree|coat\s*rack|console/i,
    "Entryway furniture (under Furniture): benches, coat racks, console & sofa tables, hall trees, storage."],
  [/home\s*improvement|faucet|toilet|sink|door/i,
    "Home Improvement: bathroom (hardware, plumbing, showers & bathtubs, sinks, toilets), doors & hardware, home gym equipment, kitchen (cabinets, faucets, sinks), outdoor (fencing, porch & deck, shutters)."],
];

function buildCategoryGuide(categories: string[]): string {
  const lines: string[] = [];
  for (const cat of categories) {
    const hint = CATEGORY_HINTS.find(([pattern]) => pattern.test(cat));
    lines.push(hint ? `  • "${cat}" — ${hint[1]}` : `  • "${cat}"`);
  }
  return lines.join("\n");
}

// ── Failure classification ────────────────────────────────────────────────────
// A systemic failure (bad/expired API key, no credit, provider outage, model
// name rejected) makes EVERY batch fail the same way. Without detecting it, the
// per-batch fallback silently marks every product "Uncategorized" and the run
// looks like it "succeeded" with zero matches — indistinguishable from a real
// categorization that found no fits. We classify these errors so the caller can
// throw a real, actionable error instead of returning all-Uncategorized.

/** Thrown when categorization fails systemically (auth, quota, outage) rather
 *  than a single product being genuinely uncategorizable. The route turns this
 *  into a user-visible error banner instead of a "0 categorized" success. */
export class CategorizationServiceError extends Error {
  constructor(message: string, readonly kind: "auth" | "quota" | "provider") {
    super(message);
    this.name = "CategorizationServiceError";
  }
}

/** Inspect a batch rejection and return a systemic-failure kind, or null if it
 *  looks like an ordinary transient/parse error worth tolerating per-batch. */
function classifySystemicError(reason: unknown): CategorizationServiceError | null {
  const err = reason as { statusCode?: number; message?: string; data?: { error?: { type?: string } } } | undefined;
  const status = err?.statusCode;
  const msg = String(err?.message ?? reason ?? "");
  const providerType = err?.data?.error?.type ?? "";

  // 401/403 or an explicit authentication error type → invalid/expired key.
  if (status === 401 || status === 403 || providerType === "authentication_error" || /api key is invalid|authentication/i.test(msg)) {
    return new CategorizationServiceError(
      "Categorization service rejected the API key (invalid or expired).",
      "auth",
    );
  }
  // Billing / quota exhaustion.
  if (status === 402 || providerType === "billing_error" || /credit|quota|billing|insufficient/i.test(msg)) {
    return new CategorizationServiceError(
      "Categorization service is out of credit or over quota. Check the Anthropic account balance, then re-run.",
      "quota",
    );
  }
  // A rejected/unknown model id fails every batch identically.
  if (status === 404 && /model/i.test(msg)) {
    return new CategorizationServiceError(
      "Categorization model was not found.",
      "provider",
    );
  }
  return null;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export type CategorizeProgress = (done: number, total: number, note?: string) => void;

export async function categorizeProducts(
  marketplace: string,
  products: ProductInput[],
  availableCategories?: string[],
  onProgress?: CategorizeProgress,
): Promise<CategorizeResult[]> {
  const mpLower = marketplace.toLowerCase();
  const isMathis = mpLower === "mathis";
  const isBestBuyTop = mpLower === "bestbuy";
  const isTemuTop = mpLower === "temu";
  const isWalmartTop = mpLower === "walmart";
  const isSearsTop = mpLower === "sears";
  const isWayfairTop = mpLower === "wayfair";

  // Temu: full taxonomy from temu_categories.csv
  if (isTemuTop) {
    availableCategories = loadTemuCategoryPaths();
  }

  // Best Buy: own electronics-focused taxonomy from bestbuy_categories.csv
  if (isBestBuyTop) {
    availableCategories = loadBestBuyCategoryPaths();
  }

  // Sears: broad-retail taxonomy from sears_categories.csv
  if (isSearsTop) {
    availableCategories = loadSearsCategoryPaths();
  }

  // Mathis works the same way: the full taxonomy sheet (mathis_categories.csv, built from
  // the official Mirakl export templates / fwd sheets) drives categorization instead of template names.
  // Top level of each path still matches the Mathis export templates, so export matching works.
  if (isMathis) {
    availableCategories = loadMathisCategoryPaths();
  }

  // Walmart: categorize into the full taxonomy when supplied, else the 75 values
  // the listing template's Product Category dropdown accepts. Either way the
  // result is mapped down to a template value at export (mapToTemplateCategory).
  if (isWalmartTop) {
    availableCategories = loadWalmartCategoryPaths();
  }

  // Wayfair: constrained to the real Wayfair class list (wayfair_categories.csv).
  // The CSV ships empty on purpose — until it is populated from Wayfair's real
  // taxonomy we must NOT free-form categorize (that would invent categories, the
  // exact reason the prior integration was reverted). Fail loudly instead so the
  // route surfaces a clear "Wayfair taxonomy not configured" banner.
  if (isWayfairTop) {
    if (!hasWayfairTaxonomy()) {
      throw new CategorizationServiceError(
        "Wayfair categorization is not configured yet: wayfair_categories.csv has no " +
        "class rows. Add Wayfair's real class taxonomy before categorizing Wayfair projects.",
        "provider",
      );
    }
    availableCategories = loadWayfairCategoryPaths();
  }

  // Constrained mode = AI must pick from a fixed list (Temu/Best Buy/Sears/Mathis/Walmart/Wayfair taxonomy)
  const isConstrained =
    (isMathis || isBestBuyTop || isTemuTop || isWalmartTop || isSearsTop || isWayfairTop) && !!availableCategories?.length;

  // Smaller batches for constrained-category marketplaces so the AI reasons carefully per product.
  // These use full taxonomy sheets — keep batches modest so the taxonomy fits with product context.
  //
  // Parallelism is intentionally LOW for constrained marketplaces (taxonomy prompt + 12 products
  // per batch → large requests). High concurrency (8+) immediately saturates Anthropic's
  // per-minute rate limit, causing most batches to get 429 errors that silently produce
  // "Uncategorized" for every product in the batch. 3 concurrent is safe for all account tiers.
  // Tunable without a redeploy via env for accounts with higher rate-limit tiers.
  const BATCH = Number(
    process.env.CATEGORIZE_BATCH_SIZE ??
      ((isTemuTop || isMathis || isBestBuyTop || isWalmartTop) ? 12 : isConstrained ? 12 : 20),
  );
  const PARALLEL = Number(process.env.CATEGORIZE_PARALLELISM ?? (isConstrained ? 3 : 5));

  const model = availableCategories?.length
    ? (process.env.CATEGORIZE_ANTHROPIC_MODEL ?? "claude-sonnet-5")
    : (process.env.DEFAULT_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001");

  const batches: ProductInput[][] = [];
  for (let i = 0; i < products.length; i += BATCH) batches.push(products.slice(i, i + BATCH));

  const allResults: CategorizeResult[] = [];

  // For constrained-taxonomy marketplaces the fallback must be "Uncategorized" so
  // a failed batch surfaces visibly for review instead of silently taking the first
  // CSV entry (which happens to be "Appliances > Major Appliances > Refrigerators").
  const batchFallback = isConstrained ? "Uncategorized" : (availableCategories?.[0] ?? "General");

  // Track batch failures so a systemic outage (bad key, no credit, provider down)
  // is reported as a real error instead of silently marking everything Uncategorized.
  let failedBatches = 0;
  let systemicError: CategorizationServiceError | null = null;

  // Retry helper for Anthropic 429 rate limit errors. Exponential backoff: 2s, 4s, 8s, 16s.
  // Without this, any 429 response silently produces "Uncategorized" for the entire batch
  // because classifySystemicError only handles 401/403/402/404.
  async function withRateLimitRetry<T>(fn: () => Promise<T>, maxRetries = 4): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const status = (err as { statusCode?: number; status?: number })?.statusCode
          ?? (err as { statusCode?: number; status?: number })?.status;
        if (status === 429 && attempt < maxRetries) {
          const delay = 2000 * Math.pow(2, attempt);
          console.warn(`[categorize] 429 rate limited (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Max retries exceeded");
  }

  for (let i = 0; i < batches.length; i += PARALLEL) {
    const group = batches.slice(i, i + PARALLEL);
    const settled = await Promise.allSettled(
      group.map((b) => withRateLimitRetry(() => categorizeBatch(b, marketplace, model, availableCategories)))
    );
    settled.forEach((s, gi) => {
      if (s.status === "rejected") {
        failedBatches++;
        console.error(`[categorize] Batch ${i + gi} failed (${marketplace}, model=${model}):`, s.reason);
        // An auth/quota/model error means every remaining batch will fail the same
        // way — capture it so we can abort with an actionable message rather than
        // grinding through the whole run producing all-Uncategorized results.
        systemicError ??= classifySystemicError(s.reason);
      }
      allResults.push(...(s.status === "fulfilled"
        ? s.value
        : group[gi].map((p) => ({ productId: p.id, category: batchFallback, path: batchFallback, confidence: 0.1 }))));
    });
    // Bail out early on a systemic failure — no point calling the API hundreds of
    // more times with a key/quota/model that will reject every one of them.
    if (systemicError) throw systemicError;
    // Small inter-wave delay for constrained marketplaces to stay within rate limits.
    if (isConstrained && i + PARALLEL < batches.length) {
      await new Promise((r) => setTimeout(r, 500));
    }
    // Report progress after every parallel wave. The job store's updatedAt advances,
    // so the client's stall detector sees a live run instead of one frozen phase string
    // for the whole (multi-minute) categorization of a large project.
    onProgress?.(Math.min(allResults.length, products.length), products.length);
  }

  // No systemic error was classified, but EVERY batch still failed (e.g. a
  // network error we didn't specifically classify). That is not a legitimate
  // "nothing matched" result — surface it as a provider failure so the run
  // doesn't report success with 100% Uncategorized.
  if (failedBatches > 0 && failedBatches === batches.length) {
    throw new CategorizationServiceError(
      "Categorization failed for every batch — the AI provider is unreachable or returning errors. Check the server logs and API configuration, then re-run.",
      "provider",
    );
  }

  // ── Validation pass ────────────────────────────────────────────────────────
  if (availableCategories?.length) {
    const allowed = new Set([...availableCategories, "Uncategorized"]);

    // Retry products that landed off-list (AI hallucinated a category name)
    const offListIds = new Set(allResults.filter((r) => !allowed.has(r.category)).map((r) => r.productId));
    if (offListIds.size > 0) {
      const retryInputs = products.filter((p) => offListIds.has(p.id));
      for (let i = 0; i < retryInputs.length; i += BATCH) {
        const batch = retryInputs.slice(i, i + BATCH);
        try {
          const retryResults = await categorizeBatch(batch, marketplace, model, availableCategories, true);
          for (const r of retryResults) {
            if (!allowed.has(r.category)) { r.category = "Uncategorized"; r.path = "Uncategorized"; r.confidence = 0.1; }
            const idx = allResults.findIndex((a) => a.productId === r.productId);
            if (idx !== -1) allResults[idx] = r;
          }
        } catch {
          for (const p of batch) {
            const idx = allResults.findIndex((a) => a.productId === p.id);
            if (idx !== -1) { allResults[idx].category = "Uncategorized"; allResults[idx].path = "Uncategorized"; }
          }
        }
        // Keep the run visibly alive through the retry pass too.
        onProgress?.(Math.min(i + batch.length, retryInputs.length), retryInputs.length, "correcting off-list results");
      }
    }

    // ── Web search rescue for Uncategorized products ───────────────────────
    // If SerpAPI is configured, search for each Uncategorized product to get
    // real-world context, then try to re-categorize with that context.
    const uncategorizedIds = new Set(allResults.filter((r) => r.category === "Uncategorized").map((r) => r.productId));
    if (uncategorizedIds.size > 0 && process.env.SERPAPI_KEY) {
      const rescueProducts = products.filter((p) => uncategorizedIds.has(p.id));

      // Search in parallel (max 5 at once to respect rate limits)
      const SEARCH_PARALLEL = 5;
      const enriched: Array<ProductInput & { searchContext?: string }> = [];
      for (let i = 0; i < rescueProducts.length; i += SEARCH_PARALLEL) {
        const slice = rescueProducts.slice(i, i + SEARCH_PARALLEL);
        const contexts = await Promise.all(slice.map((p) => searchProductContext(p.name)));
        slice.forEach((p, j) => enriched.push({ ...p, searchContext: contexts[j] ?? undefined }));
      }

      // Re-categorize with search context in small batches
      for (let i = 0; i < enriched.length; i += 5) {
        const batch = enriched.slice(i, i + 5);
        try {
          const rescueResults = await categorizeBatchWithContext(batch, marketplace, model, availableCategories);
          for (const r of rescueResults) {
            if (!allowed.has(r.category)) { r.category = "Uncategorized"; r.path = "Uncategorized"; }
            const idx = allResults.findIndex((a) => a.productId === r.productId);
            if (idx !== -1) allResults[idx] = r;
          }
        } catch { /* keep Uncategorized */ }
        onProgress?.(Math.min(i + batch.length, enriched.length), enriched.length, "web-search rescue");
      }
    }

    // ── Forced-choice pass: refused products that have REAL names ──────────────
    // The model sometimes returns "Uncategorized" for a product whose name plainly
    // identifies it ("Convene 5 Piece Outdoor Sectional Set") because no leaf names the
    // exact product type — while categorizing identical items on the same run. Those
    // refusals are over-strictness, not genuine mismatches. Re-ask ONCE with
    // "Uncategorized is not acceptable — pick the closest path". Only products with a
    // resolved human-readable name qualify: raw SKU codes stay Uncategorized, because
    // forcing a choice on a bare code would just be a guess.
    const stillRefused = allResults.filter((r) => r.category === "Uncategorized");
    if (stillRefused.length > 0) {
      const inputById = new Map(products.map((p) => [p.id, p]));
      const retryable = stillRefused
        .map((r) => inputById.get(r.productId))
        .filter((p): p is ProductInput => !!p && !looksLikeSkuName(p.name, p.sku));
      for (let i = 0; i < retryable.length; i += BATCH) {
        const batch = retryable.slice(i, i + BATCH);
        try {
          const forced = await categorizeBatch(batch, marketplace, model, availableCategories, false, true);
          for (const r of forced) {
            // Accept only a verbatim on-list path; anything else stays Uncategorized.
            if (r.category === "Uncategorized" || !allowed.has(r.category)) continue;
            const idx = allResults.findIndex((a) => a.productId === r.productId);
            if (idx !== -1) allResults[idx] = { ...r, confidence: Math.min(r.confidence, 0.5) };
          }
        } catch { /* keep Uncategorized */ }
        onProgress?.(Math.min(i + batch.length, retryable.length), retryable.length, "resolving refused products");
      }
    }
  }

  return allResults;
}

// ── Batch categorization (reasoning-first) ────────────────────────────────────
// Uses a chain-of-thought approach: asks the AI to first identify what each
// product IS before assigning a category. More accurate than direct assignment.

async function categorizeBatch(
  products: ProductInput[],
  marketplace: string,
  model: string,
  availableCategories?: string[],
  strictMode = false,
  forceNearest = false,
): Promise<CategorizeResult[]> {
  return categorizeBatchWithContext(
    products.map((p) => ({ ...p, searchContext: undefined })),
    marketplace,
    model,
    availableCategories,
    strictMode,
    forceNearest,
  );
}

async function categorizeBatchWithContext(
  products: Array<ProductInput & { searchContext?: string }>,
  marketplace: string,
  model: string,
  availableCategories?: string[],
  strictMode = false,
  forceNearest = false,
): Promise<CategorizeResult[]> {
  const mpLower = marketplace.toLowerCase();
  const isMathis = mpLower === "mathis";
  const isTemu = mpLower === "temu";
  const isBestBuy = mpLower === "bestbuy";
  const isWalmart = mpLower === "walmart";
  const isSears = mpLower === "sears";
  const isWayfair = mpLower === "wayfair";

  const list = products.map((p, idx) => {
    let line = `${idx + 1}. "${p.name}"`;
    if (p.brand) line += ` by ${p.brand}`;
    if (p.description) line += ` — ${p.description.slice(0, 150)}`;
    if (p.vendorCategory) line += ` [vendor category: ${p.vendorCategory}]`;
    if (p.vendorContext) line += ` [vendor info: ${p.vendorContext}]`;
    if (p.searchContext) line += `\n   [web search context: ${p.searchContext.slice(0, 300)}]`;
    return line;
  }).join("\n");

  let categorySection: string;
  if (isTemu && availableCategories?.length) {
    const taxonomy = formatTemuTaxonomyForPrompt();
    const closestMatchRule = `
MANDATORY ASSIGNMENT RULES:
1. Every physical product MUST get a leaf path. NEVER output "Uncategorized" for a real sellable item.
2. Focus on what the product physically IS (its core noun) — not its color, brand, or audience. Examples by product type:
   - Any hat, cap, headwear (baseball cap, beanie, sun hat, top hat, fez, tarboosh, fedora, kipah/kippah, yarmulke, turban, beret) → "Jewelry & Accessories > Hats & Caps > [closest leaf]"
   - Any crown, tiara, diadem, headpiece → "Jewelry & Accessories > Crowns & Tiaras > [closest leaf]"
   - Any children's costume, dress-up outfit, novelty suit → "Holidays & Party > Costumes & Dress-Up > Kids' Costumes"
   - Any adult costume → "Holidays & Party > Costumes & Dress-Up > Adults' Costumes"
   - Cultural/religious apparel accessory → "Jewelry & Accessories > Hats & Caps > Religious & Cultural Hats"
3. Do NOT assign based on the audience (child/adult) — assign based on what the ITEM is.
4. If two leaves are equally good, pick whichever comes first alphabetically.`;
    categorySection = `exactly one leaf path from this category taxonomy (copy character-for-character as "Category > Subcategory > Sub-Subcategory"):

${taxonomy}
${closestMatchRule}`;
  } else if (isBestBuy && availableCategories?.length) {
    const taxonomy = formatBestBuyTaxonomyForPrompt();
    const closestMatchRule = `
MANDATORY ASSIGNMENT RULES:
1. Every product MUST get a leaf path. NEVER output "Uncategorized" for a product that can be sold on Best Buy.
2. Focus on the product's primary technology function and use case.
3. Peripherals (keyboards, mice, webcams) → Computers & Tablets > Computer Accessories.
4. Wearable tech (smartwatches, fitness bands) → Health & Wellness > Wearables.
5. If a product spans two categories, pick the one matching its PRIMARY function.`;
    categorySection = `exactly one leaf path from this Best Buy category taxonomy (copy character-for-character as "Category > Subcategory > Sub-Subcategory"):

${taxonomy}
${closestMatchRule}`;
  } else if (isSears && availableCategories?.length) {
    const taxonomy = formatSearsTaxonomyForPrompt();
    const closestMatchRule = `
MANDATORY ASSIGNMENT RULES:
1. Every product MUST get a leaf path. NEVER output "Uncategorized" for a real sellable item.
2. Assign based on what the product IS — tools go to Tools & Hardware, clothing to Clothing, etc.
3. If the product spans departments (e.g. power tools in Lawn & Garden), pick the department where Sears buyers would look first.
4. Always use the full 3-level path.`;
    categorySection = `exactly one leaf path from this Sears category taxonomy (copy character-for-character as "Category > Subcategory > Sub-Subcategory"):

${taxonomy}
${closestMatchRule}`;
  } else if (isWalmart && availableCategories?.length) {
    // Walmart taxonomy — the rich taxonomy sheet when supplied, otherwise the 75
    // values the listing template accepts. Categorize into the most specific
    // entry; a rich path is mapped down to a template value at export time.
    const taxonomy = formatWalmartTaxonomyForPrompt();
    const flat = availableCategories.every((c) => !c.includes(" > "));
    const shape = flat
      ? `exactly one category from this list (copy character-for-character)`
      : `exactly one leaf path from this taxonomy (copy character-for-character as "Category > Subcategory > …")`;
    categorySection = `${strictMode ? shape.toUpperCase() : shape}:

${taxonomy}

Assign every real, sellable product to its closest match — only use "Uncategorized" when nothing fits at all.`;
  } else if (isWayfair && availableCategories?.length) {
    // Wayfair classes (wayfair_categories.csv → "Class Code - Class Name").
    // Each class maps to its own Wayfair upload template at export, so the class
    // string must be copied verbatim. Only real classes from the sheet are allowed —
    // the dispatch above already throws if the taxonomy sheet is empty.
    const taxonomy = formatWayfairTaxonomyForPrompt();
    categorySection = `${strictMode ? "EXACTLY" : "exactly"} one Wayfair class from this list (copy character-for-character as "Class Code - Class Name"):

${taxonomy}

Match by what the product physically IS (its core noun). If no listed class fits at all, use "Uncategorized".`;
  } else if (isMathis && availableCategories?.length) {
    // Full taxonomy from mathis_categories.csv (sourced from the official Mirakl fwd sheets).
    // Paths are 2–4 levels: Department > Category > Subcategory > Product Type
    // Claude must match by product-type leaf on this sheet — not general retail logic.
    const taxonomy = formatMathisTaxonomyForPrompt();
    categorySection = strictMode
      ? `EXACTLY one leaf path from this Mathis Brothers taxonomy (copy character-for-character). Match by the product-type leaf on the sheet (e.g. a Daybed → "Baby & Kids > Kids Furniture > Daybeds" because that is the ONLY Daybeds path). Do not reassign based on adult/kids assumptions:

${taxonomy}

If nothing fits, use "Uncategorized".`
      : `exactly one leaf path from this Mathis Brothers taxonomy (copy character-for-character). Match the product TYPE to the leaf name on this sheet — e.g. Daybed → "Baby & Kids > Kids Furniture > Daybeds" (only Daybeds path); do NOT pick Sofas or Beds instead:

${taxonomy}

If nothing fits, use "Uncategorized".`;
  } else if (availableCategories?.length) {
    const guide = buildCategoryGuide(availableCategories);
    categorySection = strictMode
      ? `EXACTLY one of these categories (copy the name character-for-character):\n${availableCategories.map((c) => `- ${c}`).join("\n")}`
      : `exactly one of these categories:\n${availableCategories.map((c) => `- ${c}`).join("\n")}\n\nCategory guide:\n${guide}`;
  } else {
    const taxonomies: Record<string, string> = {
      amazon: "Amazon product categories (Electronics > Cameras, Home & Kitchen > Cookware, Clothing > Men's Shoes, etc.)",
      bestbuy: "Best Buy categories (TV & Home Theater, Computers & Tablets, Cell Phones, Appliances, Gaming, etc.)",
      walmart: "Walmart categories (Electronics, Home, Clothing, Baby, Sports & Outdoors, Food, etc.)",
      mathis: "Mathis Brothers categories (Baby & Kids, Bedding & Bath, Decor, Furniture, Home Improvement, Kitchen, Mattress, Organization, Outdoor, Rugs, Seasonal)",
      sears: "Sears categories (Appliances, Tools, Clothing, Shoes, Electronics, Lawn & Garden, etc.)",
    };
    categorySection = taxonomies[mpLower] ?? `${marketplace} product categories`;
  }

  const storeContext = isMathis
    ? "You are a product categorization expert for Mathis Brothers / Mathis Home. You are given the official Mirakl taxonomy sheet (Department > Category > Subcategory > Product Type). Your job is to match each product to the leaf path whose NAME best matches the product type — using ONLY the taxonomy list. Do not invent paths. Do not relocate a product to a different department based on assumptions about adult vs kids, room type, or how a retailer 'usually' organizes furniture."
    : isTemu
    ? "You are a product categorization expert for the Temu marketplace seller portal. You are given the EXACT Temu category taxonomy (Category > Sub-Category > Product Type) sourced directly from Temu's seller listing system. Your job is to match each product to the single most specific leaf path from that taxonomy — using ONLY the paths listed. The output must be directly usable for listing on Temu's seller portal without any manual remapping. Do not invent paths. Do not shorten paths to 1 or 2 levels. Always output the full 3-level path."
    : isBestBuy
    ? "You are a product categorization expert for the Best Buy marketplace. You are given the EXACT Best Buy category taxonomy (Category > Subcategory > Sub-Subcategory). Match each product to the single most specific leaf path from that taxonomy — using ONLY the paths listed. Focus on the product's primary technology function. Do not invent paths. Always output the full 3-level path."
    : isSears
    ? "You are a product categorization expert for the Sears Marketplace. You are given the EXACT Sears category taxonomy (Category > Subcategory > Sub-Subcategory). Match each product to the single most specific leaf path from that taxonomy — using ONLY the paths listed. Sears sells tools, appliances, clothing, electronics, lawn care, automotive, and home goods. Do not invent paths. Always output the full 3-level path."
    : isWalmart
    ? "You are a product categorization expert for the Walmart Marketplace seller portal. You are given the exact category list Walmart's item-setup accepts. Match each product to the single closest category from that list — using ONLY the entries provided. The result feeds directly into a Walmart listing, so it must be one of the listed values verbatim. Do not invent categories."
    : "You are a product categorization expert for a major retail marketplace.";

  const reasoningInstruction = isMathis
    ? `For each product, match it using the TAXONOMY only:
STEP 1 — Identify the product type from the name/description (e.g. "Daybed", "Sofa", "Crib", "Table Lamp").
STEP 2 — Search the taxonomy list for a leaf (or path segment) with that same product-type name.
STEP 3 — If exactly one path contains that leaf (e.g. Daybeds only under Baby & Kids), YOU MUST use that path. Do not pick a "similar" adult Furniture path like Sofas.
STEP 4 — Only if no product-type leaf matches, fall back to the closest listed path — still from the list only.
Do NOT use outside assumptions (adult daybed → living room sofas, etc.). The taxonomy is the source of truth.`
    : isTemu
    ? `For EACH product, follow these steps in order:
STEP 1 — Identify what the product physically IS. State the core noun (e.g. "top hat", "kippah", "crown", "costume suit", "necklace"). Ignore audience (kids/adults) and color at this step.
STEP 2 — Find the taxonomy section that covers that physical object type. Example: any hat → look in "Jewelry & Accessories > Hats & Caps"; any crown/tiara → "Jewelry & Accessories > Crowns & Tiaras"; any kids costume → "Holidays & Party > Costumes & Dress-Up".
STEP 3 — Pick the single leaf within that section that most closely matches. Copy it character-for-character.
IMPORTANT: Base the category on WHAT the item is, not who it's for. A hat for a child is still a hat → Hats & Caps, not Kids' Clothing.`
    : isBestBuy
    ? `For EACH product, follow these steps:
STEP 1 — Identify the product's primary technology function (e.g. "wireless headphones", "laptop", "smart doorbell").
STEP 2 — Find the Best Buy taxonomy section matching that function (e.g. headphones → Audio > Headphones; laptop → Computers & Tablets > Laptops).
STEP 3 — Pick the single leaf that most closely matches the product's specific type. Copy it character-for-character.`
    : isSears
    ? `For EACH product, follow these steps:
STEP 1 — Identify what department the product belongs to on Sears (Appliances, Tools & Hardware, Clothing, Electronics, Lawn & Garden, etc.).
STEP 2 — Find the matching section in the Sears taxonomy, then narrow to the right subcategory and leaf.
STEP 3 — Copy the full 3-level path character-for-character.`
    : `For each product, first think: "What is this product? What does it do / who uses it?" — then pick the best category. Use your knowledge of real-world products.`;

  const mathisSizeRule = isMathis ? `
MATHIS RULES (mandatory — taxonomy over assumptions):
1. Match by PRODUCT TYPE NAME in the taxonomy first. Example: product is a "Daybed" and the sheet only has "Baby & Kids > Kids Furniture > Daybeds" → assign that path. Never substitute Sofas, Beds, or Living Room because it "looks adult".
2. Department names on the sheet are organizational labels for Mirakl — they are NOT a signal to re-interpret the product. A daybed under Baby & Kids stays Baby & Kids even if branding/size feels adult.
3. Never invent a path. Never pick a nearby category that is a different product type.
4. Prefer the deepest leaf that literally matches the product type.
5. Use "Uncategorized" only if no listed path's product type matches at all.
6. Lighting → "Decor > Lighting …". Window treatments → "Decor > Window Treatments …". Holiday decor → "Seasonal > …".
7. OUTDOOR EXCEPTION to rule 1: a product explicitly for outdoor/patio use ("Outdoor", "Patio", "Garden" in the name) MUST stay in the "Outdoor > …" department. If no Outdoor leaf names its exact type, use the closest Outdoor path (outdoor patio daybed → "Outdoor > Outdoor Seating > Outdoor Sectionals" or the nearest Outdoor Seating leaf — NEVER "Baby & Kids > Kids Furniture > Daybeds").` : "";

  // Temu's taxonomy has several branches that cover overlapping objects, which is
  // where the model most often picks a near-miss leaf. These tie-breakers encode
  // the rule Temu's own catalog uses: categorize by the item's PRIMARY FUNCTION /
  // material, not by an adjacent attribute (who it's for, what it attaches to).
  const temuDisambiguationRule = isTemu ? `
TEMU DISAMBIGUATION (apply when more than one section could fit — resolve by PRIMARY FUNCTION, not by audience, brand, color, or theme):
1. AUDIENCE ISN'T A CATEGORY. A hat, shoe, or necklace for a child is still a hat/shoe/necklace → its object section (Jewelry & Accessories, Shoes), NOT "Kids & Baby". Use "Kids & Baby" only for items that are inherently infant/toddler gear (diapers, baby bottles, cribs, strollers).
2. FUNCTION OVER ATTACHMENT. Categorize by what the item IS, not what it holds or connects to. A phone case → Electronics accessories, NOT Bags & Luggage. A watch band → Jewelry & Accessories, NOT Electronics. A laptop sleeve → Bags & Luggage only if it is a carry bag, else Electronics accessory.
3. APPAREL vs COSTUME. Everyday wearable clothing → Men's/Women's Clothing. Themed/holiday/character dress-up → "Holidays & Party > Costumes & Dress-Up". A "kids suit" for daily wear is clothing; a "kids pirate outfit" is a costume.
4. DECOR vs SEASONAL. Generic home decor → "Home & Garden". Items tied to a specific holiday (Christmas, Halloween, Easter) → "Holidays & Party".
5. MATERIAL/CRAFT vs FINISHED GOOD. Raw supplies to make something → "Arts & Crafts" or "Office & School Supplies". A finished decorated object → its object section.
6. TOOL vs APPLIANCE. Hand/power tools → "Tools & Home Improvement". Plug-in household machines (blender, vacuum, air fryer) → "Home Appliances". Kitchen-specific electric gadgets → "Kitchen & Dining".
7. SPORT/OUTDOOR vs GENERAL. Gear used for a specific sport or outdoor activity → "Sports & Outdoors". General-use versions of the same object go to their object section (a plain water bottle → Kitchen & Dining; a hydration pack → Sports & Outdoors).
8. When two leaves remain equally valid after these rules, pick the MORE SPECIFIC leaf and lower your confidence (≤0.7) so it is flagged for review.` : "";

  // Walmart's own category list legitimately includes single-word values like
  // "Other", "Furniture" and "Toys", so the generic "never output these" rule
  // must not apply — only forbid inventing values that aren't on the list.
  const noInventRule = isWalmart
    ? `2. Never invent category names — output ONLY values that appear verbatim in the list above (some ARE single words like "Furniture" or "Other"; those are valid when listed)`
    : `2. Never invent category names. Never output "General", "Other", "Furniture", "Unknown", etc.`;
  // Forced-choice pass: these products were already refused once, but each has a real,
  // identifiable product name that plainly belongs in this store — the refusal was
  // over-strictness (e.g. no literal "Outdoor Daybed" leaf), not a genuine mismatch.
  // Demand the nearest path instead of allowing a second refusal.
  const forceNearestRule = forceNearest ? `
6. "Uncategorized" is NOT an acceptable answer for any product in this batch. Every one of these is a real product this retailer sells. When no leaf names the exact product type, choose the closest broader path (e.g. an outdoor patio daybed → the nearest Outdoor Seating path; a sectional set → Outdoor Sets / Outdoor Sectionals). You MUST output a path from the list for every product.` : "";

  const rules = availableCategories?.length ? `
RULES:
1. Output EXACTLY one category name from the list above (copy it character-for-character) OR "Uncategorized" if truly no fit exists
${noInventRule}
3. "Uncategorized" is only for products that genuinely don't belong in ANY listed category
4. Use product name, brand, description, vendor category as signals to identify WHAT the product is — then map that to the taxonomy leaf
5. Do not override a direct taxonomy product-type match with general retail logic${mathisSizeRule}${temuDisambiguationRule}${forceNearestRule}` : "";

  const usesTaxonomySheet = isTemu || isMathis || isBestBuy || isWalmart || isSears;
  // The fuzzy-match floor: rich multi-word paths need a higher bar than the flat
  // 75-value list, whose category names are often 1–2 words.
  const walmartFlat = isWalmart && !(availableCategories ?? []).some((c) => c.includes(" > "));

  const jsonExample = isTemu
    ? `[{"index":1,"category":"Jewelry & Accessories > Hats & Caps > Baseball Caps","path":"Jewelry & Accessories > Hats & Caps > Baseball Caps","confidence":0.95},{"index":2,"category":"Holidays & Party > Costumes & Dress-Up > Kids' Costumes","path":"Holidays & Party > Costumes & Dress-Up > Kids' Costumes","confidence":0.90},...]`
    : isBestBuy
    ? `[{"index":1,"category":"Audio > Headphones > Wireless Headphones","path":"Audio > Headphones > Wireless Headphones","confidence":0.95},{"index":2,"category":"Computers & Tablets > Laptops > Gaming Laptops","path":"Computers & Tablets > Laptops > Gaming Laptops","confidence":0.90},...]`
    : isSears
    ? `[{"index":1,"category":"Tools & Hardware > Power Tools > Drills & Drivers","path":"Tools & Hardware > Power Tools > Drills & Drivers","confidence":0.95},{"index":2,"category":"Appliances > Major Appliances > Refrigerators","path":"Appliances > Major Appliances > Refrigerators","confidence":0.90},...]`
    : isMathis
    ? `[{"index":1,"category":"Baby & Kids > Kids Furniture > Daybeds","path":"Baby & Kids > Kids Furniture > Daybeds","confidence":0.95},...]`
    : isWalmart
    ? `[{"index":1,"category":"Furniture","path":"Furniture","confidence":0.95},{"index":2,"category":"Home Decor, Kitchen, & Other","path":"Home Decor, Kitchen, & Other","confidence":0.9},...]`
    : `[{"index":1,"category":"Category Name","path":"Category Name","confidence":0.95},...]`;

  const pathHint = isTemu
    ? `- category and path: must be the exact leaf path from the taxonomy sheet (e.g. "Jewelry & Accessories > Crowns & Tiaras > Crowns" for a crown, "Holidays & Party > Costumes & Dress-Up > Kids' Costumes" for a children's costume, "Jewelry & Accessories > Hats & Caps > Religious & Cultural Hats" for a kipah or tarboosh)`
    : isBestBuy
    ? `- category and path: must be the exact leaf path from the Best Buy taxonomy (e.g. "Audio > Headphones > Wireless Headphones" for wireless headphones, "Computers & Tablets > Laptops > Gaming Laptops" for a gaming laptop)`
    : isSears
    ? `- category and path: must be the exact leaf path from the Sears taxonomy (e.g. "Tools & Hardware > Power Tools > Drills & Drivers" for a drill, "Appliances > Major Appliances > Refrigerators" for a fridge)`
    : isMathis
    ? `- category and path: must be the exact leaf path from the taxonomy sheet (e.g. "Baby & Kids > Kids Furniture > Daybeds" when the product is a daybed — because that is where Daybeds lives on the sheet)`
    : `- path: full path e.g. "Mathis Brothers > Seasonal"`;

  // ── Prompt caching split ─────────────────────────────────────────────────
  // The taxonomy sheet (~10K tokens for Temu, up to ~12K for Mathis/Walmart) is
  // IDENTICAL for every batch of a given marketplace. Sending it inline on every
  // request re-bills those tokens each time (a 500-product run = ~100 batches ×
  // ~10K = ~1M redundant input tokens). We move all the STATIC content — store
  // context, reasoning steps, the taxonomy, and the rules — into a `system`
  // message marked with Anthropic prompt caching, and keep only the VARIABLE
  // product list in the user prompt. On a cache hit the taxonomy costs ~10% of
  // full price, so throughput/cost improve without touching categorization logic.
  //
  // For Temu/BestBuy the previous single-string prompt put products BEFORE the
  // taxonomy to avoid the model anchoring on the first taxonomy entries. Caching
  // forces the taxonomy (system) to be the prefix, so we preserve the intent a
  // different way: the STEP 1→2→3 reasoning instruction (identify the physical
  // noun first, THEN look up the taxonomy) lives in system, and the user message
  // re-states "work through the steps for EACH product first" right before the
  // product list — keeping the reason-first behavior without the ordering hack.
  const useStepByStep = isTemu || isBestBuy || isSears;

  const systemPrompt = useStepByStep
    ? `${storeContext}

${reasoningInstruction}

You will assign each product into ${categorySection}
${rules}`
    : `${storeContext}

${reasoningInstruction}

You will categorize each product into ${categorySection}
${rules}`;

  const userPrompt = useStepByStep
    ? `Work through STEP 1→2→3 for EACH product below before answering.

Products to categorize:
${list}

Respond ONLY with a JSON array — no markdown, no explanation:
${jsonExample}
${pathHint}
- confidence: 0.0–1.0 (how certain you are about the match)
- Return exactly ${products.length} items in the same order as the product list`
    : `Products:
${list}

Respond ONLY with a JSON array — no markdown, no explanation:
${jsonExample}
${pathHint}
- confidence: 0.0–1.0 (how certain you are)
- Return exactly ${products.length} items in the same order as the product list`;

  // Output-token budget scales with batch size. A fixed 2500 truncated the JSON for a
  // full batch of long Mathis/Temu paths, and a truncated array dropped the tail
  // products of the batch — the "large batches failing" symptom. ~110 tokens/item plus
  // headroom keeps the whole array inside the response.
  const perItemTokens = usesTaxonomySheet ? 110 : 80;
  const maxOutputTokens = Math.min(8000, Math.max(1500, products.length * perItemTokens + 500));

  // Cache the static system prompt (which carries the multi-thousand-token
  // taxonomy) so repeated batches for the same marketplace hit the cache instead
  // of re-billing the sheet. Only the sheet-based marketplaces have a system
  // prompt large enough to clear Anthropic's ~1024-token cache minimum and
  // benefit; for the rest, caching is a no-op we skip to avoid needless overhead.
  //
  // The cache breakpoint must sit at the END of the static system content and
  // BEFORE the variable product list, so it must be attached to the system
  // MESSAGE specifically (a top-level `providerOptions.cacheControl` on
  // generateText lands the breakpoint after the whole prompt, which re-writes
  // the cache every call and never reads it — verified empirically). We build an
  // explicit messages array to place the breakpoint precisely. The system
  // content is our own static taxonomy (never user input), so the SDK's
  // system-in-messages injection warning does not apply — suppressed below.
  const messages: ModelMessage[] = usesTaxonomySheet
    ? [
        {
          role: "system",
          content: systemPrompt,
          providerOptions: {
            anthropic: {
              // 1h cache: a large categorization run spans many minutes and
              // hundreds of batches — the longer TTL keeps the sheet warm across
              // the whole job rather than expiring mid-run (default is 5m).
              cacheControl: { type: "ephemeral", ttl: "1h" },
            },
          },
        },
        { role: "user", content: userPrompt },
      ]
    : [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];

  const { text, finishReason } = await generateText({
    model: anthropic(model),
    messages,
    allowSystemInMessages: true,
    // Temu/BestBuy/Mathis use a closed taxonomy — any valid path is correct.
    // A small temperature (0.3) helps the AI reason through niche product types
    // instead of anchoring on the first taxonomy entry seen at temperature=0.
    temperature: usesTaxonomySheet ? 0.3 : 0,
    maxOutputTokens,
  });

  const fallbackCat = usesTaxonomySheet ? "Uncategorized" : (availableCategories?.[0] ?? "General");
  const allowedSet = availableCategories ? new Set([...availableCategories, "Uncategorized"]) : null;

  const mapResult = (r: { index: number; category: string; path: string; confidence: number }) => {
    let cat = r.category?.trim() ?? "";
    if (allowedSet && !allowedSet.has(cat)) {
      // Normalize spacing around ">" then try case-insensitive / accent-insensitive match
      const fold = (s: string) =>
        s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
      const compact = (s: string) => s.replace(/\s*>\s*/g, " > ").replace(/\s+/g, " ").trim();
      const compactCat = compact(cat);
      const foldedCat = fold(compactCat);
      const ciMatch = (availableCategories ?? []).find((a) => {
        const ca = compact(a);
        return ca.toLowerCase() === compactCat.toLowerCase() || fold(ca) === foldedCat;
      });
      if (ciMatch) {
        cat = ciMatch;
      } else {
        // Word-overlap fallback — require a stronger score for long Temu paths
        const norm = (s: string) => fold(s).replace(/[^a-z0-9]+/g, " ").trim();
        const normCat = norm(cat);
        let best: string | null = null;
        let bestScore = 0;
        for (const allowed of availableCategories ?? []) {
          const normAllowed = norm(allowed);
          const score = normAllowed.split(" ").filter((w) => w.length > 2 && normCat.includes(w)).length
                      + normCat.split(" ").filter((w) => w.length > 2 && normAllowed.includes(w)).length;
          if (score > bestScore) { bestScore = score; best = allowed; }
        }
        // Flat single-word categories can't reach the 4-word overlap a long path
        // needs, so use the looser floor for Walmart's flat list.
        const minScore = walmartFlat ? 1 : usesTaxonomySheet ? 4 : 2;
        cat = bestScore >= minScore ? best! : "Uncategorized";
      }
    }
    // For taxonomy-sheet marketplaces (Temu/Mathis), path always mirrors the validated leaf category
    const path = usesTaxonomySheet ? cat : (r.path?.trim() || cat);
    return {
      productId: products[r.index - 1]?.id ?? "",
      category: cat,
      path,
      confidence: r.confidence ?? 0.5,
    };
  };

  // Parse whatever valid objects the response contains, tolerating a truncated tail:
  // pull out every complete {…} object rather than requiring the whole array to parse.
  const parseLoose = (raw: string): { index: number; category: string; path: string; confidence: number }[] => {
    const trimmed = raw.trim();
    for (const candidate of [trimmed, trimmed.match(/\[[\s\S]*\]/)?.[0] ?? ""]) {
      if (!candidate) continue;
      try { return JSON.parse(candidate); } catch { /* try object-by-object */ }
    }
    const objs: { index: number; category: string; path: string; confidence: number }[] = [];
    for (const m of trimmed.matchAll(/\{[^{}]*\}/g)) {
      try { objs.push(JSON.parse(m[0])); } catch { /* skip malformed */ }
    }
    return objs;
  };

  const parsed = parseLoose(text);
  const byId = new Map<string, CategorizeResult>();
  for (const r of parsed.map(mapResult)) if (r.productId) byId.set(r.productId, r);

  // Split-and-retry: the model returned fewer usable items than products in the batch
  // (usually a truncated response). Re-ask for ONLY the missing products in halves,
  // rather than discarding the whole batch to the fallback category.
  const missing = products.filter((p) => !byId.has(p.id));
  if (missing.length && missing.length < products.length && !strictMode) {
    const mid = Math.ceil(missing.length / 2);
    for (const half of [missing.slice(0, mid), missing.slice(mid)]) {
      if (!half.length) continue;
      try {
        for (const r of await categorizeBatch(half, marketplace, model, availableCategories, strictMode)) {
          byId.set(r.productId, r);
        }
      } catch { /* leave for the fallback below */ }
    }
  }

  if (byId.size < products.length) {
    console.error(
      `[categorize] ${products.length - byId.size}/${products.length} products unresolved ` +
      `(${marketplace}, finishReason=${finishReason}). Assigning fallback.`,
    );
  }

  // Guarantee one result per product, in input order — no product is ever dropped.
  return products.map(
    (p) => byId.get(p.id) ?? { productId: p.id, category: fallbackCat, path: fallbackCat, confidence: 0.1 },
  );
}
