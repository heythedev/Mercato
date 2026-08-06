import type { Product } from "@prisma/client";
import { ASIN_RE, barcodeVariants, toDisplayBarcode, toGtin14 } from "@/lib/barcode";
import {
  getCachedCodeLookups, getCachedProducts, cacheCodeLookup, cacheCodeLookups,
  cacheProducts, newCacheStats, logCacheStats,
} from "@/lib/keepa/cache";

/** Keepa domain for amazon.com. Verification is US-only today. */
const KEEPA_DOMAIN = 1;

export type VerifyResult = {
  productId: string;
  status: "ok" | "warning" | "mismatch" | "not_found" | "skipped" | "discontinued";
  fields: FieldResult[];
  liveData: Record<string, unknown>;
  resolvedUpc?: string; // normalized UPC extracted from vendorData when p.upc was null
};

// Check raw vendorData for a status column indicating discontinued.
// Works for both: parsed `discontinued: true` flag (new imports) and
// raw status column values (existing imported products).
function isDiscontinuedInVendorData(vendorData: unknown): boolean {
  if (!vendorData || typeof vendorData !== "object") return false;
  const data = vendorData as Record<string, unknown>;
  if (data.discontinued === true) return true;
  const statusKeyRe = /\b(status|active|availability)\b/i;
  const discValueRe = /^(d|dc|disc|discontinued|inactive|obsolete|delisted|n|no)$/i;
  for (const [key, val] of Object.entries(data)) {
    if (!statusKeyRe.test(key)) continue;
    if (discValueRe.test(String(val ?? "").trim())) return true;
  }
  return false;
}

/**
 * Identity-critical fields. A *warning* on one of these escalates the whole
 * product to "warning"; a warning on a soft field (images, description,
 * dimensions) is reported for review but does not change the product's status.
 *
 * A `mismatch` on ANY field — hard or soft — escalates regardless, so this set
 * only governs the warning tier.
 *
 * Single source of truth: this rollup is applied in three places (initial
 * comparison plus the two AI post-passes), and they must agree.
 */
const HARD_FIELDS = new Set(["title", "brand", "model", "upc"]);

/** A Walmart search hit, as returned by the Affiliate API before selection. */
type WalmartCandidate = import("@/lib/walmart/client").WalmartItem;

type FieldResult = {
  field: string;
  label: string;
  stored: string;
  live: string;
  match: boolean;
  severity: "ok" | "warning" | "mismatch";
  note?: string; // extra context shown in the UI (e.g. AI image-comparison reasoning)
  liveImage?: string; // images field only: the marketplace image URL (for thumbnail + modal preview)
  liveUrl?: string;   // images field only: the marketplace PRODUCT PAGE URL (for the "View Product" link)
};

export async function verifyProducts(
  marketplace: string,
  products: Product[],
  options?: { skipAiPasses?: boolean },
): Promise<VerifyResult[]> {
  let results: VerifyResult[];
  switch (marketplace) {
    case "amazon_us":
    case "amazon":
      try {
        results = await verifyAmazon(products);
      } catch (e) {
        // Surface what the failed attempt cost — a crashed run still spent
        // tokens, and that number is otherwise lost with the exception.
        const { getLastTokenInfo } = await import("@/lib/keepa/client");
        console.error(
          `[keepa-tokens] verify failed after partial spend; ` +
            `${getLastTokenInfo()?.tokensLeft ?? "?"} tokens remaining`,
        );
        throw e;
      }
      break;
    case "walmart":
      results = await verifyWalmart(products);
      break;
    default:
      // Only Amazon and Walmart are verified; all others pass through as ok.
      return products.map((p) => ({
        productId: p.id,
        status: "ok",
        fields: [],
        liveData: {},
      }));
  }

  if (!options?.skipAiPasses) {
    await applyAiVerificationPasses(results, products, marketplace);
  }
  return results;
}

/**
 * Run the AI post-passes (image comparison + semantic title check) on an
 * already-fetched result set. Exported so the route can call this ONCE on all
 * batch results instead of once per batch — dramatically cuts time-per-batch.
 *
 * These passes cost one model call per product, which dominates the run at
 * catalog scale (~10k products), so they are opt-in rather than automatic. The
 * `onlyFlagged` option narrows them further to the results a reviewer would
 * actually look at — a confirmed barcode match with a clean title gains nothing
 * from a vision check, while a warning/mismatch is exactly where AI adjudication
 * changes the verdict.
 */
export async function applyAiVerificationPasses(
  results: VerifyResult[],
  products: Product[],
  marketplace: string,
  options?: { onlyFlagged?: boolean },
): Promise<void> {
  let targets = results;
  if (options?.onlyFlagged) {
    // Keep flagged products AND any whose images were never compared. Filtering
    // on status alone would drop the latter: an unchecked images row reports as
    // "ok" (a warning must mean something looks wrong, not that we didn't look),
    // so those products are "ok" overall — yet they are exactly what a deep
    // check is for. Callers may pre-narrow the set; this is a safety net for
    // direct callers, not the primary filter.
    targets = results.filter(
      (r) =>
        r.status === "warning" ||
        r.status === "mismatch" ||
        r.fields.some(
          (f) => f.field === "images" && f.note?.includes("not compared"),
        ),
    );
    if (!targets.length) return;
    // Narrow the product list to match, so the passes don't scan the full set.
    const ids = new Set(targets.map((r) => r.productId));
    products = products.filter((p) => ids.has(p.id));
  }
  await applyImageComparison(targets, products);
  if (marketplace === "walmart") await applySemanticTitleCheck(targets, products);
}

// ── AI image comparison post-pass ─────────────────────────────────────────────
// For every result where both a catalog image and a marketplace image exist,
// ask a vision model whether they show the same product, then upgrade the
// "images" field from the default "warning" to "ok" (visual match) or
// "mismatch" (visibly different product). "unsure" keeps the manual-review
// warning. Degrades gracefully: without an API key nothing changes.

async function applyImageComparison(results: VerifyResult[], products: Product[]): Promise<void> {
  const { moonshotConfigured } = await import("@/lib/ai/moonshot");
  if (!moonshotConfigured()) return;

  const isUrl = (v: string | undefined): v is string => !!v && v.startsWith("http");
  const nameById = new Map(products.map((p) => [p.id, p.name]));

  type Target = { result: VerifyResult; field: FieldResult; liveImageUrls: string[] };
  const targets: Target[] = [];
  for (const r of results) {
    const field = r.fields.find((f) => f.field === "images");
    if (!field || !isUrl(field.stored)) continue;
    // Compare against the primary shot plus a couple of alternate angles. The
    // batch comparer answers MATCH if ANY angle shows the catalog product, so a
    // listing whose hero image is a detail close-up (e.g. a game board rather
    // than the whole table) still matches on one of its other angles instead of
    // being falsely flagged. images[0] is now the PRIMARY entity (sorted at
    // collection time), so the thumbnail the reviewer sees is also the hero shot.
    const liveImages = Array.isArray(r.liveData.images) ? r.liveData.images as string[] : [];
    const liveImageUrls = liveImages.filter(isUrl).slice(0, 3);
    if (!liveImageUrls.length) continue;
    targets.push({ result: r, field, liveImageUrls });
  }
  if (!targets.length) return;

  const { compareVendorAgainstAllImagesBatch } = await import("@/lib/ai/compare-images");
  const verdicts = await compareVendorAgainstAllImagesBatch(
    targets.map((t) => ({
      vendorImageUrl: t.field.stored,
      liveImageUrls: t.liveImageUrls,
      productName: nameById.get(t.result.productId) ?? "",
    })),
  );

  // Images are a soft field — an AI color-variant difference (e.g. stainless vs
  // black) shows as "mismatch" on the images row for manual review, but the
  // overall product status only rises to "warning" so genuine matching products
  // aren't falsely flagged. Hard fields come from the shared HARD_FIELDS above.
  targets.forEach((t, i) => {
    const v = verdicts[i];
    if (v.verdict === "match") {
      t.field.severity = "ok";
      t.field.match = true;
    } else if (v.verdict === "mismatch") {
      t.field.severity = "mismatch";
      t.field.match = false;
    }
    // "unsure" → keep the existing "warning" (manual review)
    t.field.note = v.verdict === "match"
      ? `AI visual check: images match — ${v.reason}`
      : v.verdict === "mismatch"
        ? `AI visual check: images differ — ${v.reason}`
        : `Needs manual review — ${v.reason}`;

    // Recompute overall status with HARD_FIELDS awareness.
    // Only hard-field mismatches (title/brand/model) → "mismatch".
    // Soft-field mismatches (images, description, dimensions) → "warning" at most.
    const hasHardMismatch = t.result.fields.some((f) => f.severity === "mismatch" && HARD_FIELDS.has(f.field));
    const hasSoftMismatch = t.result.fields.some((f) => f.severity === "mismatch" && !HARD_FIELDS.has(f.field));
    const hasHardWarning = t.result.fields.some((f) => f.severity === "warning" && HARD_FIELDS.has(f.field));
    t.result.status = hasHardMismatch ? "mismatch" : (hasSoftMismatch || hasHardWarning) ? "warning" : "ok";
  });
}

// ── AI semantic title comparison (Walmart post-pass) ──────────────────────────
// Walmart titles are often very different from vendor titles (much more verbose,
// different structure). When the basic similarity score is "warning" (borderline),
// ask Claude whether the two titles refer to the same product. This upgrades
// genuine matches to "ok" and catches semantic mismatches word-overlap misses.

async function applySemanticTitleCheck(results: VerifyResult[], products: Product[]): Promise<void> {
  const { moonshotConfigured } = await import("@/lib/ai/moonshot");
  if (!moonshotConfigured()) return;

  const nameById = new Map(products.map((p) => [p.id, p.name]));

  type Target = { result: VerifyResult; field: FieldResult; vendorTitle: string; liveTitle: string };
  const targets: Target[] = [];
  for (const r of results) {
    if (r.status === "not_found" || r.status === "discontinued") continue;
    const field = r.fields.find((f) => f.field === "title");
    if (!field || field.severity !== "warning") continue; // only re-evaluate borderline cases
    const vendorTitle = nameById.get(r.productId) ?? field.stored;
    const liveTitle = field.live;
    if (!vendorTitle || !liveTitle) continue;
    targets.push({ result: r, field, vendorTitle, liveTitle });
  }
  if (!targets.length) return;

  const { generateText } = await import("ai");
  const { moonshot, MOONSHOT_TEXT_MODEL } = await import("@/lib/ai/moonshot");

  const CONCURRENCY = 5;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (t) => {
      try {
        const { text } = await generateText({
          model: moonshot(MOONSHOT_TEXT_MODEL),
          messages: [{
            role: "user",
            content:
              `Vendor title: "${t.vendorTitle}"\n` +
              `Walmart title: "${t.liveTitle}"\n\n` +
              `Do these two titles refer to the SAME physical product (ignoring pack quantity differences, which are separate checks)?\n` +
              `Consider abbreviations, brand aliases, and different phrasings of the same product.\n` +
              `Answer on the first line: SAME or DIFFERENT\n` +
              `On the second line: one short sentence explaining why.`,
          }],
          maxOutputTokens: 100,
        });
        const lines = text.trim().split("\n").map(l => l.trim()).filter(Boolean);
        const verdict = (lines[0] ?? "").toUpperCase();
        const reason = lines.slice(1).join(" ") || "";
        if (verdict.startsWith("SAME")) {
          t.field.severity = "ok";
          t.field.match = true;
          t.field.note = `AI title check: same product — ${reason}`;
        } else if (verdict.startsWith("DIFFERENT")) {
          t.field.severity = "mismatch";
          t.field.match = false;
          t.field.note = `AI title check: different product — ${reason}`;
        }
        // Recompute overall status (HARD_FIELDS is the shared set above)
        const hasHardMismatch = t.result.fields.some(f => f.severity === "mismatch" && HARD_FIELDS.has(f.field));
        const hasSoftMismatch = t.result.fields.some(f => f.severity === "mismatch" && !HARD_FIELDS.has(f.field));
        const hasHardWarning = t.result.fields.some(f => f.severity === "warning" && HARD_FIELDS.has(f.field));
        t.result.status = hasHardMismatch ? "mismatch" : (hasSoftMismatch || hasHardWarning) ? "warning" : "ok";
      } catch { /* leave existing severity in place */ }
    }));
  }
}

// ── Amazon (Keepa) ────────────────────────────────────────────────────────────

async function verifyAmazon(products: Product[]): Promise<VerifyResult[]> {
  const { getProducts, getProductsByCode, keywordSearch, getLastTokenInfo, normalizeMany } = await import("@/lib/keepa");
  const { refreshKeepaTokens: refreshTokens, tokensSpentMark, tokensSpentSince } =
    await import("@/lib/keepa/client");
  const stats = newCacheStats();

  // Token accounting for this batch. Refresh first so the starting balance is
  // real rather than whatever the last call happened to leave behind.
  const startInfo = await refreshTokens();
  const spendMark = tokensSpentMark();
  console.log(
    `[keepa-tokens] start: ${startInfo?.tokensLeft ?? "?"} available` +
      `${startInfo?.refillRate ? ` (refill ${startInfo.refillRate}/min)` : ""}` +
      `, ${products.length} product${products.length === 1 ? "" : "s"} to verify`,
  );

  /**
   * Report what this batch actually cost. Always logs, including the zero case
   * — "0 tokens used" is the signal that the cache did its job, so staying
   * silent on a fully-cached run would hide the number worth seeing.
   */
  let usageLogged = false;
  const logTokenUsage = () => {
    if (usageLogged) return; // the finally-guard must not double-report
    usageLogged = true;
    const used = tokensSpentSince(spendMark);
    const left = getLastTokenInfo()?.tokensLeft;
    const perProduct = products.length ? (used / products.length).toFixed(1) : "0";
    console.log(
      `[keepa-tokens] used ${used} token${used === 1 ? "" : "s"} for ${products.length} ` +
        `product${products.length === 1 ? "" : "s"} (${perProduct}/product), ` +
        `${left ?? "?"} remaining`,
    );
  };

  // Products the vendor file explicitly marks as discontinued — skip Keepa entirely.
  const discontinuedResults: VerifyResult[] = products
    .filter((p) => isDiscontinuedInVendorData(p.vendorData))
    .map((p) => ({ productId: p.id, status: "discontinued" as const, fields: [], liveData: {} }));
  const activeProducts = products.filter((p) => !isDiscontinuedInVendorData(p.vendorData));

  // Extract a barcode from vendorData when p.upc is null or invalid.
  // Vendor files often have UPC/EAN/barcode in columns with non-standard headers
  // that the importer didn't map to the upc field.
  const extractVendorUpc = (p: Product): string | null => {
    const vd = p.vendorData as Record<string, unknown> | null;
    if (!vd) return null;
    // Priority 1: known barcode column names
    const barcodeKeys = /\b(upc|ean|gtin|barcode|isbn|item[\s_-]*code|product[\s_-]*code)\b/i;
    for (const [k, v] of Object.entries(vd)) {
      if (!barcodeKeys.test(k)) continue;
      const norm = toDisplayBarcode(String(v ?? ""));
      if (norm) return norm;
    }
    // Priority 2: any column whose value looks like a barcode (8-14 digits after normalization)
    for (const v of Object.values(vd)) {
      const norm = toDisplayBarcode(String(v ?? ""));
      if (norm && norm.length >= 12) return norm;
    }
    return null;
  };

  // Resolve the best UPC for each product: stored p.upc → normalize → fallback vendorData scan
  const resolvedUpc = (p: Product): string | null =>
    toDisplayBarcode(p.upc) ?? extractVendorUpc(p);

  const withAsin     = activeProducts.filter((p) => p.asin && ASIN_RE.test(p.asin));
  const asinInvalid  = activeProducts.filter((p) => p.asin && !ASIN_RE.test(p.asin));
  // A product "has UPC" if p.upc normalizes OR vendorData contains a barcode
  const withUpcOnly  = activeProducts.filter((p) => (!p.asin || !ASIN_RE.test(p.asin ?? "")) && !!resolvedUpc(p));
  const withNameOnly = activeProducts.filter((p) => (!p.asin || !ASIN_RE.test(p.asin ?? "")) && !resolvedUpc(p));

  // Fetch by ASIN
  const asinResults = new Map<string, VerifyResult>();
  if (withAsin.length) {
    const asins = withAsin.map((p) => p.asin) as string[];
    // Serve what we already have; only pay Keepa for the rest.
    const cached = await getCachedProducts(KEEPA_DOMAIN, asins);
    const missing = asins.filter((a) => !cached.has(a));
    stats.productHits += cached.size;
    stats.productMisses += missing.length;

    const fetched = missing.length
      ? await getProducts(KEEPA_DOMAIN, missing, { stats: 1, rating: true })
      : [];
    if (fetched.length) await cacheProducts(KEEPA_DOMAIN, fetched);

    const raw = [...cached.values(), ...fetched];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const live = normalizeMany(raw, 1) as any[];
    // Don't throw on empty — Keepa may simply not carry these ASINs. Mark as not_found and continue.
    const liveMap = new Map(live.map((l) => [l.asin as string, l]));
    for (const p of withAsin) {
      const lp = liveMap.get(p.asin!);
      if (!lp) { asinResults.set(p.id, notFound(p.id)); continue; }
      // ASIN is the most definitive product identity — always trust it.
      // Don't reject based on title similarity: vendor files often use abbreviations.
      // Build the Amazon product page URL from the ASIN (not the image URL)
      const liveDataForCompare = {
        ...lp,
        productUrl: lp.asin ? `https://www.amazon.com/dp/${lp.asin as string}` : "",
      };
      const result = compareToLive(p, lp.title as string, lp.brand as string ?? null, null, liveDataForCompare as Record<string, unknown>, "Amazon");
      // Downgrade mismatch → warning for ASIN-confirmed products (title abbreviation ≠ wrong product),
      // but keep pack-quantity mismatches hard — ASIN may still be a multipack listing.
      const packMismatch = extractPackQty(p.name) !== extractPackQty(String(lp.title ?? ""));
      if (result.status === "mismatch" && !packMismatch) {
        result.status = "warning";
        result.fields = result.fields.map((f) =>
          f.severity === "mismatch" ? { ...f, severity: "warning" as const } : f
        );
      }
      asinResults.set(p.id, result);
    }
  }
  void asinInvalid; // they flow into withUpcOnly / withNameOnly above

  // Fetch by UPC/EAN barcode
  // Build a map: every normalized code variant → product, so Keepa response codes
  // (which may be stored as EAN-13) can be matched back to the originating product.
  const upcResults = new Map<string, VerifyResult>();
  const upcNotFound: Product[] = [];
  if (withUpcOnly.length) {
    const codeToProduct = new Map<string, Product>();
    for (const p of withUpcOnly) {
      for (const v of barcodeVariants(resolvedUpc(p))) codeToProduct.set(v, p);
    }
    const allCodes = [...new Set(codeToProduct.keys())];

    // Resolve what the cache already knows. Codes with a remembered answer —
    // including a remembered absence — never reach Keepa.
    const cachedLookups = await getCachedCodeLookups(KEEPA_DOMAIN, allCodes);
    const cachedAsins = [...new Set([...cachedLookups.values()].flat())];
    const cachedProducts = await getCachedProducts(KEEPA_DOMAIN, cachedAsins);

    // A cached mapping is usable when every ASIN it names also has a cached
    // payload — otherwise we'd have an ASIN with no data behind it.
    const resolvedByCache = new Set<string>();
    // Codes cached as "Amazon doesn't carry this". Tracked separately from
    // resolved-with-data because `[].every()` is vacuously true, which would
    // otherwise class a negative as a satisfied lookup.
    const cachedAbsent = new Set<string>();
    for (const [code, asins] of cachedLookups) {
      if (!asins.length) cachedAbsent.add(code);
      else if (asins.every((a) => cachedProducts.has(a))) resolvedByCache.add(code);
    }
    const toFetch = allCodes.filter((c) => {
      const g = toGtin14(c);
      if (!g) return true;
      return !resolvedByCache.has(g) && !cachedAbsent.has(g);
    });
    stats.codeHits += allCodes.length - toFetch.length;
    stats.codeMisses += toFetch.length;
    stats.productHits += cachedProducts.size;

    const { products: fetchedProducts, failedCodes } = toFetch.length
      ? await getProductsByCode(KEEPA_DOMAIN, toFetch, { stats: 1 })
      : { products: [], failedCodes: [] as string[] };
    if (fetchedProducts.length) await cacheProducts(KEEPA_DOMAIN, fetchedProducts);

    // Codes whose batch never completed aren't "not found" — they're unasked.
    // Distinguishing them keeps a transient outage from being recorded as fact.
    const unresolved = new Set(failedCodes);
    const rawProducts = [...cachedProducts.values(), ...fetchedProducts];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const liveNorm = normalizeMany(rawProducts, 1) as any[];

    // Map every barcode Keepa returns → list of normalized live products.
    // Coerce codes to string: some Keepa responses return numeric EANs.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const codeToLiveList = new Map<string, (typeof liveNorm[number])[]>();
    rawProducts.forEach((raw, idx) => {
      const norm = liveNorm[idx];
      if (!norm) return;
      const codes = [...(raw.eanList ?? []), ...(raw.upcList ?? [])]
        .map((c) => String(c).trim())
        .filter((c) => c.length >= 8);
      for (const code of codes) {
        if (!codeToLiveList.has(code)) codeToLiveList.set(code, []);
        codeToLiveList.get(code)!.push(norm);
      }
    });

    // Cached mappings resolve by ASIN, since a cached payload may not echo the
    // barcode back the way a fresh response does.
    for (const code of resolvedByCache) {
      for (const asin of cachedLookups.get(code) ?? []) {
        const idx = rawProducts.findIndex((r) => r.asin === asin);
        const norm = idx >= 0 ? liveNorm[idx] : null;
        if (!norm) continue;
        if (!codeToLiveList.has(code)) codeToLiveList.set(code, []);
        codeToLiveList.get(code)!.push(norm);
      }
    }

    // Record what the fetched batch taught us, so the next upload skips it.
    const learned = new Map<string, string[]>();
    for (const code of toFetch) {
      if (unresolved.has(code)) continue; // never asked — not a fact
      const g = toGtin14(code);
      if (!g) continue;
      const hits = (codeToLiveList.get(code) ?? [])
        .map((c) => c?.asin as string | undefined)
        .filter((a): a is string => !!a);
      // An empty list here is a genuine "Keepa has no product for this code".
      learned.set(g, [...new Set([...(learned.get(g) ?? []), ...hits])]);
    }
    if (learned.size) {
      await cacheCodeLookups(
        KEEPA_DOMAIN,
        [...learned].map(([code, asins]) => ({ code, asins, source: "batch" as const })),
      );
    }

    for (const p of withUpcOnly) {
      // Collect candidates across all variants (UPC-12 + EAN-13)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let candidates: (typeof liveNorm[number])[] = [];
      for (const v of barcodeVariants(resolvedUpc(p))) {
        for (const c of (codeToLiveList.get(v) ?? [])) candidates.push(c);
        // Cache-resolved codes are keyed by GTIN-14, not by the raw variant.
        const g = toGtin14(v);
        if (g && g !== v) for (const c of (codeToLiveList.get(g) ?? [])) candidates.push(c);
      }

      // The batch never completed for this product's codes — we don't know
      // whether Amazon carries it. Report "skipped" rather than letting it fall
      // into keyword search, which would guess an ASIN from a network error.
      if (!candidates.length && barcodeVariants(resolvedUpc(p)).some((c) => unresolved.has(c))) {
        upcResults.set(p.id, { productId: p.id, status: "skipped", fields: [], liveData: {} });
        continue;
      }

      // Cached "Amazon doesn't carry this barcode" — the answer is already
      // known, so skip both the rescue call and the keyword cascade.
      if (!candidates.length) {
        const g = toGtin14(resolvedUpc(p));
        if (g && cachedAbsent.has(g)) {
          upcResults.set(p.id, notFound(p.id));
          continue;
        }
      }

      // Code map miss — Keepa may have returned the product but not populated
      // eanList/upcList (common for some catalog entries). Do a targeted
      // single-product rescue lookup.
      if (!candidates.length) {
        const rescueCodes = barcodeVariants(resolvedUpc(p));
        if (rescueCodes.length) {
          try {
            const { products: rescueRaw, failedCodes: rescueFailed } =
              await getProductsByCode(KEEPA_DOMAIN, rescueCodes, { stats: 1 });
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const rescueNorm = normalizeMany(rescueRaw, 1) as any[];
            candidates = rescueNorm.filter(Boolean);
            if (rescueRaw.length) await cacheProducts(KEEPA_DOMAIN, rescueRaw);
            // Only record when Keepa actually answered — a failed rescue says
            // nothing about whether the product exists.
            if (!rescueFailed.length) {
              const g = toGtin14(resolvedUpc(p));
              if (g) {
                await cacheCodeLookup(
                  KEEPA_DOMAIN, g,
                  candidates.map((c) => c?.asin as string).filter(Boolean),
                  "rescue",
                );
              }
            }
          } catch { /* fall through to upcNotFound */ }
        }
      }

      if (!candidates.length) {
        upcNotFound.push(p);
        continue;
      }

      // Pack qty is critical: if catalog is a single unit, never accept "Pack of N" /
      // "Case of N" ASINs — even when they share the UPC (common Amazon multipack reuse).
      // Prefer pack-compatible candidates; if none, fall through to keyword search so we
      // can find the single-unit listing (often under a different UPC).
      const packCompatible = filterPackCompatible(p.name, candidates);
      if (!packCompatible.length) {
        upcNotFound.push(p);
        continue;
      }

      // Pick the best ASIN using multi-signal scoring (not just title).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const best: any = pickBestCandidate(p, packCompatible);

      // A UPC barcode IS the product identity — do NOT reject based on title similarity.
      // Vendor files often use heavy abbreviations ("PWR STRP 360PRO") that share zero words
      // with the full Amazon title ("360 Electrical Pro Heavy Duty Hexacore"). The UPC match
      // is definitive — trust it unconditionally and let compareToLive report the title diff
      // as a warning rather than silently returning not_found.
      const resolved = resolvedUpc(p);
      const result = compareToLive(p, best.title as string, (best.brand as string) ?? null, null, best as Record<string, unknown>, "Amazon");
      if (resolved && !p.upc) result.resolvedUpc = resolved;
      // UPC-confirmed: soft-downgrade abbreviation mismatches → warning.
      // Pack-qty mismatches stay hard (should be rare after filterPackCompatible).
      const packMismatch = extractPackQty(p.name) !== extractPackQty(String(best.title ?? ""));
      if (result.status === "mismatch" && !packMismatch) {
        result.status = "warning";
        result.fields = result.fields.map((f) =>
          f.severity === "mismatch" ? { ...f, severity: "warning" as const } : f
        );
      }
      upcResults.set(p.id, result);
    }
  }

  // ── Brand expansion: vendor acronym → ALL known Amazon brand names ───────────
  // Use products already found via ASIN/UPC to resolve acronyms.
  // "GHF" → ["Greenland Home Fashions", "Barefoot Bungalow"] (both are GHF sub-brands).
  // We try EACH of these when keyword-searching for unresolved products.
  const brandAllOptions = new Map<string, Set<string>>();
  const trackBrand = (vendorBrand: string | null, result: VerifyResult | undefined) => {
    if (!vendorBrand || !result || result.status === "not_found") return;
    const amazonBrand = result.liveData?.brand as string | undefined;
    if (!amazonBrand) return;
    const vb = vendorBrand.toLowerCase();
    if (!brandAllOptions.has(vb)) brandAllOptions.set(vb, new Set());
    brandAllOptions.get(vb)!.add(amazonBrand);
  };
  for (const p of withAsin)    trackBrand(p.brand, asinResults.get(p.id));
  for (const p of withUpcOnly) trackBrand(p.brand, upcResults.get(p.id));

  // Keyword search for:
  //  (a) products with no ASIN or UPC at all
  //  (b) products whose UPC Keepa couldn't match (upcNotFound fallback)
  const nameResults = new Map<string, VerifyResult>();

  // A cached empty result means the full cascade already ran for this barcode
  // and found nothing. Re-running it would spend ~8 searches to reach the same
  // verdict, so answer from cache and keep them out of the pool entirely.
  const cascadeCodes = upcNotFound
    .map((p) => toGtin14(resolvedUpc(p)))
    .filter((g): g is string => !!g);
  const knownAbsent = cascadeCodes.length
    ? await getCachedCodeLookups(KEEPA_DOMAIN, cascadeCodes)
    : new Map<string, string[]>();
  const stillUnknown = upcNotFound.filter((p) => {
    const g = toGtin14(resolvedUpc(p));
    if (g && knownAbsent.get(g)?.length === 0) {
      nameResults.set(p.id, notFound(p.id));
      stats.codeHits++;
      return false;
    }
    return true;
  });

  const keywordPool = [...withNameOnly, ...stillUnknown];
  if (keywordPool.length) {
    const { refreshKeepaTokens } = await import("@/lib/keepa/client");
    const tokenInfo = await refreshKeepaTokens();
    if (tokenInfo != null && tokenInfo.tokensLeft < 200) {
      // Tokens too low — skip keyword searches rather than crashing the whole batch
      console.warn(
        `[keepa-tokens] only ${tokenInfo.tokensLeft} left (need 200) — ` +
          `skipping keyword search for ${keywordPool.length} product${keywordPool.length === 1 ? "" : "s"}`,
      );
      for (const p of keywordPool) nameResults.set(p.id, { productId: p.id, status: "skipped", fields: [], liveData: {} });
      logCacheStats(stats);
      logTokenUsage();
      return [...discontinuedResults, ...activeProducts.map((p) =>
        asinResults.get(p.id) ?? upcResults.get(p.id) ?? nameResults.get(p.id)
        ?? { productId: p.id, status: "skipped" as const, fields: [] as FieldResult[], liveData: {} }
      )];
    }

    // Deduplicate by brand+name so identical products share one search pass
    const byTerm = new Map<string, Product[]>();
    for (const p of keywordPool) {
      const term = [p.brand, p.name].filter(Boolean).join(" ").trim();
      if (!byTerm.has(term)) byTerm.set(term, []);
      byTerm.get(term)!.push(p);
    }

    const CONCURRENCY = 1;
    const entries = [...byTerm.entries()];
    for (let i = 0; i < entries.length; i += CONCURRENCY) {
      const left = getLastTokenInfo()?.tokensLeft;
      if (left != null && left < 200) break;

      await Promise.all(entries.slice(i, i + CONCURRENCY).map(async ([_term, group]) => {
        try {
          const productName = group[0].name || _term;
          const vendorBrand = group[0].brand ?? null;

          // All Amazon brand names we've seen for this vendor brand (e.g. "GHF" →
          // ["Greenland Home Fashions", "Barefoot Bungalow"]). Fall back to raw vendor
          // brand string if we haven't seen this brand in any successful lookup yet.
          const knownBrands: string[] = vendorBrand
            ? [...(brandAllOptions.get(vendorBrand.toLowerCase()) ?? []), vendorBrand]
                .filter((b, i, a) => a.indexOf(b) === i) // deduplicate
            : [];

          // Cache Keepa results by search term so Strategy 5 (same terms, lower threshold)
          // doesn't repeat API calls already made by Strategies 1/2.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const apiCache = new Map<string, any[]>();

          // Vendor model/part number — exact match against a candidate's model/MPN
          // is a definitive identity signal that overrides title similarity.
          const vendorModel = extractModelNumber(group[0].vendorData);

          const searchAndPick = async (searchTerm: string, minSim = 0.4) => {
            const cacheKey = searchTerm.toLowerCase().trim();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let normed: any[];
            if (apiCache.has(cacheKey)) {
              normed = apiCache.get(cacheKey)!;
            } else {
              const { asinList } = await keywordSearch(1, searchTerm);
              if (!asinList.length) { apiCache.set(cacheKey, []); return null; }
              const rawFound = await getProducts(1, asinList.slice(0, 20), { stats: 1 });
              normed = normalizeMany(rawFound, 1);
              apiCache.set(cacheKey, normed);
            }
            if (!normed.length) return null;

            // Prefer candidates whose pack qty matches the catalog title (single ≠ Pack of N).
            const packMatched = filterPackCompatible(productName, normed);
            const pool = packMatched.length ? packMatched : normed;

            // Exact model/MPN match wins — but ONLY among pack-compatible candidates.
            // Never let a multipack win just because the model number matches; if only
            // multipacks match the model, we skip the early return and let the pack
            // guard below reject them so we keep searching for the single-unit listing.
            if (vendorModel) {
              const vm = modelNorm(vendorModel);
              for (const n of packMatched) {
                const candModels = [n.model, n.partNumber]
                  .filter((m: unknown): m is string => typeof m === "string" && !!m.trim())
                  .map(modelNorm);
                if (candModels.includes(vm)) return { best: n, bestSim: 1 };
              }
            }
            let best = pool[0];
            let bestSim = titleSim(productName, best.title);
            for (const n of pool.slice(1)) {
              const s = titleSim(productName, n.title);
              if (s > bestSim) { best = n; bestSim = s; }
            }
            // If we had to fall back to pack-mismatched candidates, require a stronger title match
            // and still reject explicit multipacks when the catalog is a single unit.
            if (!packMatched.length) {
              const vendorQty = extractPackQty(productName);
              const liveQty = extractPackQty(String(best.title ?? ""));
              if (vendorQty !== liveQty) return null;
            }
            return bestSim >= minSim ? { best, bestSim } : null;
          };

          // Need at least one searchable word
          const nameWords = productName.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2);
          if (!nameWords.length) {
            for (const p of group) nameResults.set(p.id, notFound(p.id));
            return;
          }

          // Extract vendor SKU — present on most products (model/part numbers appear
          // in Amazon listing titles and are very precise identifiers).
          const vendorSku = group[0].vendorSku?.trim() || null;
          // A useful SKU is alphanumeric, ≥ 4 chars, not a pure integer (pure integers are often internal IDs)
          const isUsefulSku = vendorSku && /^[A-Z0-9][A-Z0-9\-_]{3,}$/i.test(vendorSku) && !/^\d+$/.test(vendorSku);

          let match = null;

          // ── Strategy 0: vendor model number / SKU ────────────────────────────────
          // Model numbers and SKUs are the most precise identifiers after ASINs and
          // UPCs. Many Amazon listings include the manufacturer model number in the
          // title, and Keepa indexes model/MPN for keyword search.
          if (!match && vendorModel && vendorModel !== vendorSku) {
            match = await searchAndPick(vendorModel, 0.15);
            if (!match && vendorBrand) match = await searchAndPick(`${vendorBrand} ${vendorModel}`.trim(), 0.15);
          }
          if (!match && isUsefulSku) {
            match = await searchAndPick(vendorSku!, 0.15);
            if (!match && vendorBrand) match = await searchAndPick(`${vendorBrand} ${vendorSku}`.trim(), 0.15);
          }

          // ── Strategy 1: each known full Amazon brand + product name ────────────
          // "Greenland Home Fashions Mermaid", then "Barefoot Bungalow Mermaid", etc.
          for (const brand of knownBrands) {
            if (brand.toLowerCase() === vendorBrand?.toLowerCase()) continue; // skip acronym, try last
            match = await searchAndPick(`${brand} ${productName}`.trim());
            if (match) break;
          }

          // ── Strategy 1.5: shortened brand names (first 2 words) ──────────────
          // e.g. "Greenland Home" from "Greenland Home Fashions" — many Amazon
          // listings use the short form and keyword search misses the full-name version.
          if (!match) {
            const shortBrands = [...new Set(
              knownBrands
                .filter(b => b.split(/\s+/).length > 2)
                .map(b => b.split(/\s+/).slice(0, 2).join(" "))
            )];
            for (const brand of shortBrands) {
              match = await searchAndPick(`${brand} ${productName}`.trim());
              if (match) break;
            }
          }

          // ── Strategy 2: product name only ─────────────────────────────────────
          if (!match) match = await searchAndPick(productName);

          // ── Strategy 3: vendor brand acronym + name (original term) ───────────
          if (!match && vendorBrand && vendorBrand !== productName) {
            match = await searchAndPick(`${vendorBrand} ${productName}`.trim());
          }

          // ── Strategy 4: UPC as keyword (for UPC-fallback products) ────────────
          // Amazon indexes barcodes — searching the UPC often surfaces the exact listing.
          if (!match) {
            const upc = group.find(p => p.upc)?.upc;
            if (upc) match = await searchAndPick(upc, 0.25);
          }

          // ── Strategy 5: relax threshold to 0.3 and try all brands again ───────
          // Last-ditch effort: something is better than "not found".
          if (!match) {
            for (const brand of knownBrands) {
              match = await searchAndPick(`${brand} ${productName}`.trim(), 0.3);
              if (match) break;
            }
          }
          if (!match) match = await searchAndPick(productName, 0.3);

          if (!match) {
            for (const p of group) nameResults.set(p.id, notFound(p.id));
            // The full strategy cascade ran and found nothing. That verdict cost
            // ~8 searches to reach, so remember it — otherwise every re-upload of
            // the same file pays for the same cascade to reach the same answer.
            // (The catch below is deliberately not cached: an error means we
            // never got a verdict.)
            for (const p of group) {
              const g = toGtin14(resolvedUpc(p));
              if (g) await cacheCodeLookup(KEEPA_DOMAIN, g, [], "keyword");
            }
            return;
          }

          const { best } = match;
          for (const p of group) {
            nameResults.set(p.id, compareToLive(
              p, best.title, best.brand ?? null, null,
              best as unknown as Record<string, unknown>,
              "Amazon",
            ));
          }
          // Remember the keyword resolution against each product's barcode.
          // This is the most valuable cache entry there is: one hit here skips
          // the whole ~20-call strategy cascade next time. Marked "keyword" so
          // it expires sooner — a fuzzy title match is a guess, not a barcode.
          if (best.asin) {
            for (const p of group) {
              const g = toGtin14(resolvedUpc(p));
              if (g) await cacheCodeLookup(KEEPA_DOMAIN, g, [best.asin as string], "keyword");
            }
          }
        } catch {
          for (const p of group) nameResults.set(p.id, notFound(p.id));
        }
      }));
    }
  }

  // Assemble results in original order.
  // Products with no entry in any map were in the keyword-search queue but the loop broke
  // before processing them (token exhaustion). Mark as "skipped" so the route preserves
  // their previous DB state rather than overwriting with not_found.
  const activeResults = activeProducts.map((p) =>
    asinResults.get(p.id) ?? upcResults.get(p.id) ?? nameResults.get(p.id)
    ?? { productId: p.id, status: "skipped" as const, fields: [] as FieldResult[], liveData: {} }
  );
  logCacheStats(stats);
  logTokenUsage();
  return [...discontinuedResults, ...activeResults];
}

// ── Walmart (Marketplace API) ─────────────────────────────────────────────────

/**
 * Shared limiter for a whole verify run. Created once per process so the
 * discovered concurrency ceiling carries across batches instead of every batch
 * re-probing it from `start` and paying the same warm-up.
 */
let walmartLimiter: InstanceType<typeof import("@/lib/walmart/throttle").AdaptiveLimiter> | null = null;

async function getWalmartLimiter() {
  if (!walmartLimiter) {
    const { AdaptiveLimiter } = await import("@/lib/walmart/throttle");
    // Ceiling measured against the live Affiliate API: throughput rises to
    // ~57 calls/s at concurrency 128 with flat p95 latency and zero failures,
    // so the previous max of 64 was our own bottleneck rather than Walmart's.
    // Starting high (rather than ramping from 16) matters because a 10k run is
    // many short batches — a slow ramp would spend most of the run warming up.
    walmartLimiter = new AdaptiveLimiter({ start: 96, min: 8, max: 160 });
  }
  return walmartLimiter;
}

// ── Seller-API circuit breaker ────────────────────────────────────────────────
// The Seller API searches OUR OWN Walmart catalog, so it only ever hits for
// products we already list. A vendor file of prospective products misses 100%
// of the time — measured at 3563/3563 on a real 4k run — yet still costs one
// call per product, ~40% of that run's total API traffic.
//
// So: probe a sample, and if none are in our catalog, stop asking and let the
// Affiliate lookup handle the rest. A project that genuinely contains our own
// listings hits within the probe window and never trips.
//
// State lives at module scope so the decision carries across batches; a
// per-batch breaker would re-probe every BATCH_SIZE products and never save the
// bulk of the calls. `resetSellerBreaker()` clears it between runs.

/** Lookups to sample before concluding the seller catalog holds none of these products. */
const SELLER_PROBE_SIZE = 150;

type SellerBreaker = { probe: number; hits: number; tripped: boolean; record(hit: boolean): void };
let sellerBreakerState: SellerBreaker | null = null;

function getSellerBreaker(): SellerBreaker {
  if (!sellerBreakerState) {
    sellerBreakerState = {
      probe: 0,
      hits: 0,
      tripped: false,
      record(hit: boolean) {
        if (this.tripped) return;
        this.probe++;
        if (hit) this.hits++;
        // Decide once, after a sample large enough that even a low hit rate
        // would almost certainly have shown up.
        if (this.probe >= SELLER_PROBE_SIZE && this.hits === 0) {
          this.tripped = true;
          console.log(
            `[walmart-seller] no catalog hits in ${this.probe} lookups — skipping the ` +
              `Seller API for the rest of this run (these products are not in your ` +
              `Walmart catalog). Saves ~1 API call per remaining product.`,
          );
        }
      },
    };
  }
  return sellerBreakerState;
}

/** Clear the breaker so a new run re-probes. Called when a fresh verify starts. */
export function resetWalmartRunState(): void {
  sellerBreakerState = null;
}

async function verifyWalmart(products: Product[]): Promise<VerifyResult[]> {
  const { searchWalmartByUpc, searchWalmartCandidates } = await import("@/lib/walmart/client");
  const { getSellerItemByGtin, sellerApiConfigured } = await import("@/lib/walmart/seller-client");
  const { runPool } = await import("@/lib/walmart/throttle");
  const {
    getCachedItems, cacheItems, codeKey, queryKey,
    newWalmartCacheStats, logWalmartCacheStats,
  } = await import("@/lib/walmart/cache");

  // The Affiliate API only reliably indexes Walmart's first-party retail
  // catalog, so our own freshly-published seller listings often come back empty
  // there even while live on walmart.com. The Seller API reads OUR catalog
  // directly, so a GTIN hit here authoritatively confirms our listing — this is
  // the primary lookup, with the Affiliate search kept as a fallback.
  const useSellerApi = sellerApiConfigured();
  const limiter = await getWalmartLimiter();
  const stats = newWalmartCacheStats();

  // Mark discontinued products immediately
  const discontinuedResults: VerifyResult[] = products
    .filter((p) => isDiscontinuedInVendorData(p.vendorData))
    .map((p) => ({ productId: p.id, status: "discontinued" as const, fields: [], liveData: {} }));
  const activeProducts = products.filter((p) => !isDiscontinuedInVendorData(p.vendorData));

  // ── Cache preload ───────────────────────────────────────────────────────────
  // One bulk read for the whole batch. Every key that resolves here — including
  // remembered absences — skips its entire API cascade below.
  const keysFor = (p: Product): { seller: string | null; upc: string | null } => {
    const g = codeKey(p.upc);
    return { seller: g ? `s:${g}` : null, upc: g };
  };
  const preloadStart = Date.now();
  const preloadKeys: string[] = [];
  for (const p of activeProducts) {
    const k = keysFor(p);
    if (k.seller) preloadKeys.push(k.seller);
    if (k.upc) preloadKeys.push(k.upc);
    // Name-search fallbacks must be preloaded too, otherwise their cache is
    // written every run but never read — the fallback path is the expensive one,
    // so missing these would forfeit most of the re-run savings.
    const brandName = [p.brand, p.name].filter(Boolean).join(" ").trim();
    if (brandName) preloadKeys.push(queryKey(brandName));
    if (p.name) preloadKeys.push(queryKey(p.name));
  }
  const cached = await getCachedItems<Record<string, unknown>>(preloadKeys);
  const preloadMs = Date.now() - preloadStart;

  // Counts every outbound Walmart request this batch makes. The ratio of calls
  // to products is the single most diagnostic number when a run is slow: ~1.0
  // means the cascade is short-circuiting early, ~3+ means most products are
  // falling through to the name-search fallbacks.
  const apiCalls = { count: 0 };

  const sellerBreaker = getSellerBreaker();

  // Writes are collected and flushed once at the end rather than per-product.
  const pendingCacheWrites: Array<{
    key: string;
    item: unknown | null;
    source: "seller" | "upc" | "name";
  }> = [];

  // Deduplicate in-flight name searches: a batch often contains many products
  // sharing a brand+name query, and without this each one pays for its own call.
  //
  // The cache stores the full CANDIDATE LIST rather than a single chosen item,
  // because selection depends on the product being looked up (its barcode and
  // model code) while the search result depends only on the query. Caching the
  // pre-selection list keeps one query's results reusable across products.
  const nameSearchInFlight = new Map<string, Promise<WalmartCandidate[]>>();
  const searchCandidates = async (query: string): Promise<WalmartCandidate[]> => {
    if (!query) return [];
    const key = queryKey(query);
    const hit = cached.get(key);
    if (hit !== undefined) {
      stats.hits++;
      if (hit === null) stats.negativeHits++;
      return (hit as WalmartCandidate[] | null) ?? [];
    }
    let inflight = nameSearchInFlight.get(key);
    if (!inflight) {
      inflight = (async () => {
        stats.misses++;
        apiCalls.count++;
        const items = await limiter
          .run(() => searchWalmartCandidates(query))
          .catch(() => [] as WalmartCandidate[]);
        pendingCacheWrites.push({ key, item: items.length ? items : null, source: "name" });
        return items;
      })();
      nameSearchInFlight.set(key, inflight);
    }
    return inflight;
  };

  /**
   * Name-search fallback: fetch candidates, then accept one only if the evidence
   * supports it. Previously this took Walmart's first hit on faith, which is how
   * sibling SKUs (adjacent model numbers, different sizes) became "matches".
   */
  const findByName = async (p: Product): Promise<WalmartCandidate | null> => {
    const queries = [
      [p.brand, p.name].filter(Boolean).join(" ").trim(),
      p.name ?? "",
    ].filter((q, i, a) => q && a.indexOf(q) === i);

    for (const q of queries) {
      const candidates = await searchCandidates(q);
      const picked = pickWalmartCandidate(p.name ?? "", p.upc, candidates);
      if (picked) return picked;
    }
    return null;
  };

  const lookupStart = Date.now();
  const settled = await runPool(activeProducts, limiter, async (p) => {
      let item = null;
      const k = keysFor(p);

      // Primary: confirm our OWN published listing via the Seller API by GTIN.
      // Skipped entirely once the circuit breaker trips — see `sellerBreaker`.
      if (useSellerApi && p.upc && k.seller && !sellerBreaker.tripped) {
        let seller: Awaited<ReturnType<typeof getSellerItemByGtin>> = null;
        const cachedSeller = cached.get(k.seller);
        if (cachedSeller !== undefined) {
          stats.hits++;
          if (cachedSeller === null) stats.negativeHits++;
          seller = cachedSeller as Awaited<ReturnType<typeof getSellerItemByGtin>>;
        } else {
          stats.misses++;
          apiCalls.count++;
          seller = await getSellerItemByGtin(p.upc).catch(() => null);
          pendingCacheWrites.push({ key: k.seller, item: seller, source: "seller" });
          sellerBreaker.record(!!seller);
        }
        if (seller) {
          const priceInCents = seller.price != null ? Math.round(seller.price * 100) : null;
          const images = (seller.images ?? []).filter((u) => u.startsWith("http"));
          const isPublished = (seller.publishedStatus ?? "").toUpperCase() === "PUBLISHED";
          const productUrl = seller.itemId ? `https://www.walmart.com/ip/${seller.itemId}` : "";
          const liveDataForCompare = {
            ...seller,
            images,
            description: "",
            productUrl,
            // Surface publish status so the report can flag a matched-but-not-live listing.
            publishedStatus: seller.publishedStatus ?? "UNKNOWN",
          };
          const result = compareToLive(
            p,
            seller.productName ?? "",
            seller.brand ?? null,
            priceInCents,
            liveDataForCompare as unknown as Record<string, unknown>,
            "Walmart",
          );
          // Our own catalog item that is not PUBLISHED is a real problem to
          // surface (staged / unpublished / in-progress), not an "ok".
          if (!isPublished && result.status === "ok") {
            result.status = "warning";
            result.fields.push({
              field: "availability", label: "Availability",
              stored: "Expected live", live: seller.publishedStatus ?? "Not published",
              match: false, severity: "warning",
              note: `Listing found in your Walmart catalog but status is ${seller.publishedStatus ?? "unknown"}, not PUBLISHED`,
            });
          }
          return result;
        }
        // Seller API had no match — fall through to the Affiliate lookup below.
      }

      // Track whether the UPC lookup specifically failed so we can apply a
      // stricter title guard on the name-search fallback result.
      let upcLookupFailed = false;

      if (p.upc) {
        // Try UPC-based lookup first; fall back to name search if Walmart doesn't index by UPC.
        // Some legitimate products (especially newer listings) aren't indexed by UPC yet.
        const cachedUpc = k.upc ? cached.get(k.upc) : undefined;
        if (cachedUpc !== undefined) {
          stats.hits++;
          if (cachedUpc === null) stats.negativeHits++;
          item = cachedUpc as typeof item;
        } else {
          stats.misses++;
          apiCalls.count++;
          item = await limiter.run(() => searchWalmartByUpc(p.upc!)).catch(() => null);
          if (k.upc) pendingCacheWrites.push({ key: k.upc, item, source: "upc" });
        }
        if (!item) {
          // UPC lookup found nothing — fall back to name search, but only accept
          // a candidate the evidence actually supports (see pickWalmartCandidate).
          item = await findByName(p) as typeof item;
        }
      } else {
        item = await findByName(p) as typeof item;
      }

      if (!item) return notFound(p.id);

      // Guard against false positives from the name-search fallback.
      // When the vendor has a UPC that Walmart's index didn't carry, and the
      // name search returns a product with a COMPLETELY DIFFERENT UPC, we likely
      // found a similar-looking product from the same brand (e.g. "Bon 14-460
      // Band Breaker" matching "Bon 14-284 Base Plate").  Require the title to
      // meet the "ok" similarity bar before accepting the match; below that,
      // treat it as not found rather than surfacing a wrong comparison.
      if (upcLookupFailed && p.upc && item.upc) {
        const upcDigits = (u: string) => u.replace(/\D/g, "");
        const vD = upcDigits(p.upc);
        const lD = upcDigits(item.upc);
        const sameUpc = vD === lD
          || (vD.length === 12 && lD === "0" + vD)
          || (lD.length === 12 && vD === "0" + lD);
        if (!sameUpc) {
          const wv = normalizeTitle(p.name);
          const wl = normalizeTitle(item.name ?? "");
          const sim = titleSim(p.name, item.name ?? "");
          let hits = 0;
          for (const w of wv) if (wl.has(w)) hits++;
          const recall = wv.size > 0 ? hits / wv.size : 0;
          if (sim < 0.35 && recall < 0.55) return notFound(p.id);
        }
      }

      const priceInCents = item.salePrice != null ? Math.round(item.salePrice * 100) : null;
      // Build Walmart product page URL from itemId (not the image URL)
      const slug = (item.name ?? "product")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
      const walmartProductUrl = item.itemId
        ? `https://www.walmart.com/ip/${slug}/${item.itemId}`
        : "";

      // Collect ALL image angles: imageEntities (all secondary/primary shots) + fallback top-level fields.
      // Walmart does NOT guarantee imageEntities[0] is the hero/primary shot — a
      // secondary angle (e.g. a close-up detail) can come first. Since the
      // thumbnail shown in the UI and the image sent to the AI comparison are
      // both images[0], we must sort the PRIMARY entity to the front so the
      // representative image is the actual hero shot, not an arbitrary angle.
      const entityImages = (item.imageEntities ?? [])
        .slice()
        .sort((a, b) => {
          const rank = (e: { entityType?: string }) =>
            (e.entityType ?? "").toUpperCase() === "PRIMARY" ? 0 : 1;
          return rank(a) - rank(b);
        })
        .map((e) => e.largeImage ?? e.thumbnailImage)
        .filter((u): u is string => !!u && u.startsWith("http"));
      const allImages = [
        ...entityImages,
        item.largeImage,
        item.thumbnailImage,
      ].filter((u): u is string => !!u && u.startsWith("http"))
       .filter((u, i, arr) => arr.indexOf(u) === i); // deduplicate

      // `variants` and `imageEntities` are the two largest fields Walmart
      // returns and nothing downstream reads either: the angles we care about
      // are already flattened into `images` above. Keeping them made liveData
      // ~13KB per product, so a 7k export spent a minute loading 87MB of JSON
      // it never looked at. Dropped before persisting.
      const {
        variants: _variants,
        imageEntities: _imageEntities,
        ...itemForStorage
      } = item as typeof item & { variants?: unknown };
      const liveDataForCompare = {
        ...itemForStorage,
        images: allImages,
        description: item.shortDescription ?? item.longDescription ?? "",
        productUrl: walmartProductUrl,
      };
      return compareToLive(
        p,
        item.name ?? "",
        item.brandName ?? null,
        priceInCents,
        liveDataForCompare as unknown as Record<string, unknown>,
        "Walmart",
      );
  });

  const results: VerifyResult[] = settled.map((s, j) =>
    s.status === "fulfilled" ? s.value : notFound(activeProducts[j].id),
  );

  const lookupMs = Date.now() - lookupStart;

  // Flush everything this batch learned in a couple of writes rather than one
  // per product, then report what the cache saved.
  const cacheWriteStart = Date.now();
  await cacheItems(pendingCacheWrites);
  const cacheWriteMs = Date.now() - cacheWriteStart;

  logWalmartCacheStats(stats);
  // Per-batch timing breakdown. Without this a slow run is just "slow" — this
  // says whether the cost is API latency, rate-limit backoff, or DB writes.
  const perProduct = activeProducts.length ? lookupMs / activeProducts.length : 0;
  console.log(
    `[walmart-timing] ${activeProducts.length} products in ${(lookupMs / 1000).toFixed(1)}s ` +
      `(${perProduct.toFixed(0)}ms/product) | preload ${preloadMs}ms | ` +
      `cache-write ${cacheWriteMs}ms | api-calls ${apiCalls.count}`,
  );
  console.log(
    `[walmart-throttle] concurrency settled at ${limiter.width} ` +
      `(peak ${limiter.stats.peakLimit}), ${limiter.stats.rateLimited} rate-limited, ` +
      `${limiter.stats.errors} errors | mean call ${limiter.meanLatencyMs.toFixed(0)}ms, ` +
      `slowest ${limiter.stats.maxLatencyMs}ms`,
  );

  return [...discontinuedResults, ...results];
}

// ── BestBuy ───────────────────────────────────────────────────────────────────

async function verifyBestBuy(products: Product[]): Promise<VerifyResult[]> {
  const apiKey = process.env.BESTBUY_API_KEY;
  if (!apiKey) throw new Error("BESTBUY_API_KEY not configured. Add BESTBUY_API_KEY to .env");

  const results: VerifyResult[] = [];
  const CONCURRENCY = 10;

  for (let i = 0; i < products.length; i += CONCURRENCY) {
    const batch = products.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(async (p) => {
      const query = encodeURIComponent(p.upc ? `upc=${p.upc}` : `name=${p.name}`);
      const url = `https://api.bestbuy.com/v1/products(${query})?apiKey=${apiKey}&show=name,brand,salePrice,upc&format=json&pageSize=1`;
      const res = await fetch(url).catch(() => null);
      if (!res?.ok) return notFound(p.id);
      const data = await res.json();
      const item = data.products?.[0];
      if (!item) return notFound(p.id);
      return compareToLive(p, item.name, item.brand, item.salePrice ? Math.round(item.salePrice * 100) : null, item, "Best Buy");
    }));
    for (const s of settled) results.push(s.status === "fulfilled" ? s.value : notFound(batch[results.length % CONCURRENCY]?.id ?? ""));
  }

  return results;
}

// ── SerpAPI (Temu / Walmart / Mathis / Sears) ─────────────────────────────────

async function verifySerpApi(marketplace: string, products: Product[]): Promise<VerifyResult[]> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error("SERPAPI_KEY not configured. Add it to .env to verify non-Amazon marketplaces.");

  return Promise.all(
    products.map(async (p) => {
      const query = encodeURIComponent(`${p.name} ${p.brand ?? ""} site:${marketplace}.com`);
      const url = `https://serpapi.com/search.json?q=${query}&engine=google_shopping&api_key=${apiKey}`;
      const res = await fetch(url).catch(() => null);
      if (!res?.ok) return notFound(p.id);
      const data = await res.json();
      const item = data.shopping_results?.[0];
      if (!item) return notFound(p.id);
      const priceNum = typeof item.price === "string"
        ? Math.round(parseFloat(item.price.replace(/[^0-9.]/g, "")) * 100)
        : null;
      return compareToLive(p, item.title, item.source ?? null, priceNum, item, marketplace);
    })
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function notFound(productId: string): VerifyResult {
  return {
    productId,
    status: "not_found",
    fields: [{ field: "availability", label: "Availability", stored: "In Stock", live: "Not found on marketplace", match: false, severity: "mismatch" }],
    liveData: {},
  };
}

function compareToLive(
  p: Product,
  liveTitle: string,
  liveBrand: string | null,
  _livePriceCents: number | null,
  liveData: Record<string, unknown>,
  marketplace = "Marketplace",
): VerifyResult {
  const fields: FieldResult[] = [];

  // Title — semantic similarity + recall signal + pack-quantity mismatch check
  const sim = titleSim(p.name, liveTitle);
  // Recall: what fraction of vendor title words are found in the live title?
  // Walmart/Walmart titles are often much longer and more verbose. A short vendor
  // title like "iStep 6 Inch Running Board" is fully contained within a longer
  // Walmart title like "APS iStep 6 Inch Black Running Board Nerf Bars for Jeep…"
  // The Jaccard score drops because of the many extra Walmart words, but recall
  // tells us the vendor's key terms are all there.
  const wv = normalizeTitle(p.name);
  const wl = normalizeTitle(liveTitle);
  let recallHits = 0;
  for (const w of wv) if (wl.has(w)) recallHits++;
  const recall = wv.size > 0 ? recallHits / wv.size : 0;

  // Walmart titles are much more verbose than vendor titles (vendor: "Kinder's BBQ 5.5oz",
  // Walmart: "Kinder's Buttery Steakhouse® Seasoning, 5.5 oz."). High recall (vendor words
  // found in live title) is a strong match signal even when Jaccard is low due to extra words.
  let titleSeverity: "ok" | "warning" | "mismatch" =
    sim >= 0.35 || recall >= 0.55 ? "ok"
    : sim >= 0.15 || recall >= 0.35 ? "warning"
    : "mismatch";
  // Pack-quantity check: if vendor title has no quantity (= 1) and live title says "Pack of N"
  // (N > 1), or vice-versa, that is a definitive mismatch regardless of word similarity.
  const vendorDesc = String((p.vendorData as Record<string,unknown> | null)?.description ?? p.description ?? "");
  const liveDesc = String(liveData.description ?? liveData.shortDescription ?? liveData.longDescription ?? "");
  const vendorQty = extractPackQty(p.name, vendorDesc);
  const liveQty = extractPackQty(liveTitle, liveDesc);
  let titleNote: string | undefined;
  if (vendorQty !== liveQty) {
    titleSeverity = "mismatch";
    titleNote = vendorQty === 1
      ? `Catalog is a single unit, but ${marketplace} title is a multipack (qty ${liveQty})`
      : `Pack quantity mismatch: catalog qty ${vendorQty} vs ${marketplace} qty ${liveQty}`;
  }

  // Model-code check: when BOTH titles carry a product code from the same
  // family and the codes differ, that is definitive — regardless of word
  // similarity. Word-overlap scoring is blind here: "Bon 11-482 Flat Slicker"
  // vs "Bon 11-385 English Plugging Chisel" shares only "bon" and "inch",
  // which is still enough to clear the warning threshold and avoid a mismatch,
  // even though the codes say plainly they are different products.
  const codeConflict = titleCodeConflict(p.name, liveTitle);
  if (codeConflict) {
    titleSeverity = "mismatch";
    titleNote = `Model codes differ: catalog ${codeConflict.vendor} vs ${marketplace} ${codeConflict.live}`;
  }
  fields.push({
    field: "title", label: "Title",
    stored: p.name, live: liveTitle,
    match: titleSeverity === "ok",
    severity: titleSeverity,
    ...(titleNote ? { note: titleNote } : {}),
  });

  // UPC field — surface in the verification report so users can see whether UPC was matched
  const vendorUpc = p.upc ?? String((p.vendorData as Record<string,unknown> | null)?.upc ?? "");
  const liveUpc = String(liveData.upc ?? liveData.itemUpc ?? "");
  // Hoisted: an exact barcode match is normally definitive product identity,
  // which other field comparisons below (images, brand) use to avoid demanding
  // manual review for a product whose identity is already proven.
  //
  // IMPORTANT: it is only treated as proof when nothing else contradicts it.
  // Marketplace listings sometimes carry the WRONG barcode — a real case in this
  // catalog has Walmart showing UPC 743153114827 (a Flat Slicker, model 11-482)
  // on a listing for an English Plugging Chisel, model 11-385. Trusting the UPC
  // unconditionally there would suppress the image and brand review on a product
  // that is plainly not the same item, and report it as a clean Match.
  //
  // So a title mismatch vetoes the carve-out: when the barcode says "same" and
  // the title says "different", the disagreement itself is the signal, and the
  // product must stay flagged for a human rather than being quietly passed.
  let upcConfirmed = false;
  if (vendorUpc) {
    const upcMatch = liveUpc ? vendorUpc.replace(/\D/g, "").endsWith(liveUpc.replace(/\D/g, "")) ||
      liveUpc.replace(/\D/g, "").endsWith(vendorUpc.replace(/\D/g, "")) : false;
    upcConfirmed = upcMatch && titleSeverity !== "mismatch";
    // Three distinct outcomes, which must NOT collapse into one severity:
    //
    //  • match            → ok. Definitive identity.
    //  • no live UPC      → warning. "Could not verify" — absence of evidence.
    //  • conflicting UPCs → mismatch. Evidence of absence: two different
    //    barcodes are two different products. Previously this was only a
    //    warning, and since `upc` is not a HARD field it never escalated the
    //    product — leaving 619 products in one real run marked "Match" while
    //    carrying a barcode that disagreed with the listing (e.g. catalog
    //    11-303 / 8.4 cu ft matched to Walmart 11-304 / 4.5 cu ft).
    const upcConflict = !!liveUpc && !upcMatch;
    // Only contradict a UPC match when model CODES differ (e.g. catalog 11-482
    // vs listing 11-385 — same barcode on a different product is a catalogue
    // error). A pack-quantity difference is NOT evidence the barcode is wrong —
    // it is the same product in a different pack size, so UPC stays "ok".
    const upcContradicted = upcMatch && !!codeConflict;
    fields.push({
      field: "upc", label: "UPC",
      stored: vendorUpc, live: liveUpc || "N/A",
      match: upcMatch,
      severity: upcMatch ? (upcContradicted ? "warning" : "ok")
        : upcConflict ? "mismatch" : "warning",
      ...(upcContradicted
        ? { note: "UPC matches, but the titles describe different products — the marketplace listing may have the wrong barcode. Verify manually." }
        : liveUpc
          ? (upcMatch ? {} : {
              note: "Vendor UPC does not match the marketplace UPC — this is a different product",
            })
          : { note: "Marketplace listing has no UPC — could not verify" }),
    });
  }

  // Brand — standard matching + cross-check with product titles.
  // Vendors often store the parent-company name ("APS") while the marketplace
  // shows the product-line brand ("iStep"). If the live brand appears in the
  // vendor's product title, or the vendor brand appears in the live title,
  // we know it's the same product family.
  const liveBrandInVendorTitle = !!(liveBrand && p.name.toLowerCase().includes(liveBrand.toLowerCase()));
  const vendorBrandInLiveTitle = !!(p.brand && liveTitle.toLowerCase().includes(p.brand.toLowerCase()));
  // A confirmed barcode match settles the question: the same GTIN is the same
  // physical product, so differing brand strings are a naming difference
  // (sub-brand, product line, parent company) rather than a wrong listing.
  // "Bon Pro Plus" vs "Bon Tool" is the canonical case — brandsMatch() misses it
  // because its shared-keyword rule only considers words longer than 3 chars,
  // which discards the very token they share ("Bon").
  const brandMatch = !p.brand || !liveBrand
    || upcConfirmed
    || brandsMatch(p.brand, liveBrand)
    || liveBrandInVendorTitle
    || vendorBrandInLiveTitle;
  fields.push({
    field: "brand", label: "Brand",
    stored: p.brand ?? "N/A", live: liveBrand ?? "N/A",
    match: brandMatch,
    severity: brandMatch ? "ok" : "warning",
    // Only annotate the non-obvious pass: brands that read as different but are
    // reconciled by the barcode. A plain string match needs no explanation.
    ...(brandMatch && upcConfirmed && p.brand && liveBrand
      && !brandsMatch(p.brand, liveBrand)
      && !liveBrandInVendorTitle && !vendorBrandInLiveTitle
      ? { note: "Brand differs, but the exact UPC match confirms it is the same product." }
      : {}),
  });

  // Model number — compare vendor's model/part number against live listing's model/MPN
  const vdRaw = (p.vendorData as Record<string, unknown> | null) ?? {};
  const vendorModel = extractModelNumber(p.vendorData);
  const liveModel =
    (typeof liveData.model === "string" && liveData.model.trim() ? liveData.model.trim() : null) ||
    (typeof liveData.partNumber === "string" && liveData.partNumber.trim() ? liveData.partNumber.trim() : null);
  const modelMatch = !vendorModel || !liveModel || modelNorm(vendorModel) === modelNorm(liveModel);
  fields.push({
    field: "model", label: "Model Number",
    stored: vendorModel ?? "N/A",
    live: liveModel ?? "N/A",
    match: modelMatch,
    severity: !vendorModel || !liveModel ? "ok" : modelMatch ? "ok" : "warning",
  });

  // Colour — derived from the vendor title/description on our side, and from the
  // marketplace's colour attribute (falling back to its title) on theirs.
  // Reported as two explicit values so a reviewer can see both without opening
  // the listing. A colour stated on only one side is "not stated", not a
  // conflict: most vendor titles omit it entirely.
  const vendorColour = extractColour(
    `${p.name ?? ""} ${vendorDesc}`,
    (p.vendorData as Record<string, unknown> | null) ?? null,
  );
  const liveColour = extractColour(
    `${liveTitle} ${liveDesc}`,
    liveData as Record<string, unknown>,
  );
  const colourComparable = !!vendorColour && !!liveColour;
  const colourMatch = !colourComparable || vendorColour === liveColour;
  fields.push({
    field: "colour", label: "Colour",
    stored: vendorColour ?? "Not stated",
    live: liveColour ?? "Not stated",
    match: colourMatch,
    // Soft: a colour difference is worth surfacing, but marketplaces and vendors
    // name shades differently often enough that it should not condemn a product
    // on its own. It escalates only when the AI/other hard fields also disagree.
    severity: colourMatch ? "ok" : "warning",
    ...(colourComparable && !colourMatch
      ? { note: `Colour differs: catalog "${vendorColour}" vs ${marketplace} "${liveColour}"` }
      : !colourComparable
        ? { note: "Colour not stated on both sides — could not compare" }
        : {}),
  });

  // Pack / Set quantity — extracted from title and description on both sides.
  // The title check above already treats a pack-quantity difference as a hard
  // mismatch (a single unit is not a 6-pack); this row exists so the report
  // shows the two quantities side by side, which is what a reviewer needs to
  // confirm the call.
  fields.push({
    field: "pack", label: "Pack / Set Qty",
    stored: String(vendorQty),
    live: String(liveQty),
    match: vendorQty === liveQty,
    severity: vendorQty === liveQty ? "ok" : "mismatch",
    ...(vendorQty !== liveQty
      ? { note: `Pack quantity differs: catalog ${vendorQty} vs ${marketplace} ${liveQty}` }
      : {}),
  });

  // Images — start as "warning" whenever a vendor image exists; the AI visual
  // comparison post-pass (applyImageComparison) upgrades this to "ok" or
  // "mismatch" after actually looking at both images. If the AI is unavailable
  // or unsure, the "warning" stands and signals manual review.
  const liveImages = Array.isArray(liveData.images) ? liveData.images as string[] : [];
  const hasLiveImages = liveImages.length > 0;
  const vendorImgUrl = p.imageUrl || (() => {
    for (const [k, v] of Object.entries(vdRaw)) {
      if (/image|img|photo|picture|thumbnail/i.test(k) && typeof v === "string" && v.startsWith("http")) return v;
    }
    return null;
  })();
  const hasVendorImage = !!vendorImgUrl;
  // Images are a soft, advisory field — a difference here never proves the
  // listing is wrong (angles, packaging shots and lifestyle photos all differ
  // legitimately). So only ask for manual review when the images are actually
  // the best evidence available:
  //
  //  • nothing to compare (no vendor image)            → ok
  //  • identity already proven by an exact UPC match   → ok
  //  • catalog has an image, marketplace has none      → warning (worth seeing)
  //  • otherwise                                        → warning (review)
  //
  // The UPC carve-out is the important one. Previously ANY product with a
  // catalog image was flagged, so a barcode-confirmed product with visibly
  // identical images still surfaced as a Warning — and since the AI visual check
  // is opt-in, nothing ever cleared it. That made Warning the default state for
  // correctly-matched products rather than a signal worth acting on.
  //
  // Equally, "ok" must not mean "we didn't look". A missing catalog image is a
  // real data gap the reviewer needs to see: with no image there is nothing to
  // compare, so calling it ok reported a pass for a check that never ran.
  const imagesUnchecked = hasVendorImage && hasLiveImages && !upcConfirmed;
  const imgSeverity: "ok" | "warning" =
    // No catalog image at all — a gap in our own data, not a pass.
    !hasVendorImage ? "warning"
    : upcConfirmed && hasLiveImages ? "ok"
    // Both sides have images but no UPC confirmation — images were NEVER compared.
    // Reporting "ok" here meant "we didn't look" was indistinguishable from a pass.
    : imagesUnchecked ? "warning"
    // Our catalog has an image and the marketplace listing has none.
    : "warning";
  // For the report `live` value: prefer a product page URL over raw image URL —
  // more useful in the exported report. The UI uses the dedicated liveImage /
  // liveUrl fields below to render a thumbnail plus a "View Product" link.
  // Prefer explicit productUrl, then Keepa's amazonUrl, then build from ASIN.
  const asin = typeof liveData.asin === "string" ? liveData.asin.trim() : "";
  const liveProductUrl =
    (typeof liveData.productUrl === "string" && liveData.productUrl) ||
    (typeof liveData.amazonUrl === "string" && liveData.amazonUrl) ||
    (asin ? `https://www.amazon.com/dp/${asin}` : "") ||
    "";
  const liveImgOrUrl = liveProductUrl || liveImages[0] || "N/A";
  fields.push({
    field: "images", label: "Images",
    stored: vendorImgUrl ?? "N/A",
    live: liveImgOrUrl,
    match: hasVendorImage ? hasLiveImages : true,
    severity: imgSeverity,
    // Default note. The AI visual check (applyImageComparison) overwrites this
    // with its verdict when it runs; if it's skipped (opt-in / no API key) or
    // errors, this stays so the row never shows a bare, unexplained state.
    note: imgSeverity === "warning"
      ? (!hasVendorImage
          ? "No catalog image — nothing to compare. Add an image to the vendor sheet."
          : imagesUnchecked
            ? "Images not compared — verify manually or run AI deep check."
            : "Catalog has an image but the marketplace listing has none — review manually.")
      : hasVendorImage && upcConfirmed && hasLiveImages
        // Say why this passed without a visual comparison — otherwise a silent
        // "ok" looks like the images were checked when they were not.
        ? "Product identity confirmed by exact UPC match — images not compared."
        : undefined,
    liveImage: liveImages[0] ?? "",
    liveUrl: liveProductUrl,
  });

  // Description — compare vendor description with live description/features.
  // Skip comparison when the vendor description is too short or looks like
  // placeholder/restricted text — these produce false warnings because they
  // have near-zero word overlap with any real marketplace description.
  const liveDescFull = [
    liveDesc,
    ...(Array.isArray(liveData.features) ? liveData.features as string[] : []),
  ].filter(Boolean).join(" ");
  const vendorDescWords = vendorDesc.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(w => w.length > 3);
  // Placeholder detection: too short (<8 meaningful words) OR common filler phrases
  const isPlaceholderDesc = vendorDescWords.length < 8
    || /\b(restricted|confidential|proprietary|call for|n\/a|see image|coming soon|tbd|contact us)\b/i.test(vendorDesc);
  const descSim = !isPlaceholderDesc && vendorDesc && liveDescFull ? wordOverlap(vendorDesc, liveDescFull) : null;
  fields.push({
    field: "description", label: "Description",
    stored: vendorDesc || "N/A",
    live: liveDescFull ? liveDescFull.slice(0, 200) + (liveDescFull.length > 200 ? "…" : "") : "N/A",
    match: descSim == null || descSim >= 0.1,
    severity: descSim == null ? "ok" : descSim >= 0.1 ? "ok" : "warning",
  });

  // Dimensions — try two sources; pick the one closer to the marketplace package dims.
  // Source 1: stored dimensions string (may be product size like "90x90" for quilts)
  // Source 2: L/W/H columns from vendorData (individual item package dims)
  // IMPORTANT: dimension differences are NEVER a hard mismatch — max severity is "warning"
  // because vendor product dims and marketplace package dims use different measurement conventions.
  const vendorDimStr = (vdRaw.dimensions as string | null) ?? null;
  const dims1 = vendorDimStr ? parseDims(vendorDimStr) : null;

  const getVdNum = (...names: string[]): number | null => {
    for (const [k, v] of Object.entries(vdRaw)) {
      if (names.some(n => k.toLowerCase() === n.toLowerCase())) {
        const num = parseFloat(String(v).replace(/[^0-9.]/g, ""));
        if (!isNaN(num) && num > 0) return num;
      }
    }
    return null;
  };
  const vL = getVdNum("Length", "Len");
  const vW = getVdNum("Width", "Wid", "Wide");
  const vH = getVdNum("Height", "Hgt", "Ht", "Depth", "Dep");
  const dims2: [number, number, number] | null = vL && vW && vH ? [vL, vW, vH] : null;

  const liveL = typeof liveData.lengthMm === "number" && liveData.lengthMm > 0 ? liveData.lengthMm / 25.4 : null;
  const liveW = typeof liveData.widthMm === "number" && liveData.widthMm > 0 ? liveData.widthMm / 25.4 : null;
  const liveH = typeof liveData.heightMm === "number" && liveData.heightMm > 0 ? liveData.heightMm / 25.4 : null;
  const liveDims = liveL && liveW && liveH ? [liveL, liveW, liveH].sort((a, b) => b - a) as [number, number, number] : null;

  const calcDiff = (vendor: [number, number, number], live: [number, number, number]): number => {
    const vs = [...vendor].sort((a, b) => b - a) as [number, number, number];
    return Math.max(...vs.map((v, i) => Math.abs(v - live[i]) / Math.max(v, 1)));
  };

  // Filter out product-sized dims (e.g. 90×90 quilt) — only compare package-sized dims (all values ≤ 60")
  const isPackageSized = (d: [number, number, number]) => Math.max(...d) <= 60;
  const usableDims1 = dims1 && isPackageSized(dims1) ? dims1 : null;
  const usableDims2 = dims2 && isPackageSized(dims2) ? dims2 : null;

  let bestDims = usableDims1 ?? usableDims2;
  let bestDimDisplay = vendorDimStr || (dims2 ? `${vL} × ${vW} × ${vH}` : null);
  if (liveDims && usableDims1 && usableDims2) {
    if (calcDiff(usableDims2, liveDims) < calcDiff(usableDims1, liveDims)) {
      bestDims = usableDims2;
      bestDimDisplay = `${vL} × ${vW} × ${vH}`;
    }
  } else if (!usableDims1 && usableDims2) {
    bestDimDisplay = `${vL} × ${vW} × ${vH}`;
  }

  // Dimensions are max "warning" — they never cause "mismatch" status on their own
  let dimSeverity: "ok" | "warning" = "ok";
  let dimMatch = true;
  if (bestDims && liveDims) {
    const maxDiff = calcDiff(bestDims, liveDims);
    dimMatch = maxDiff <= 0.25;
    dimSeverity = maxDiff <= 0.25 ? "ok" : "warning";
  }
  fields.push({
    field: "dimensions", label: "Dimensions",
    stored: bestDimDisplay || "N/A",
    live: liveDims ? `${liveDims[0].toFixed(1)}" × ${liveDims[1].toFixed(1)}" × ${liveDims[2].toFixed(1)}" (L×W×H)` : "N/A",
    match: dimMatch,
    severity: dimSeverity,
  });

  // Status rollup — distinguish hard fields (identity-critical) from soft fields
  // (informational). A warning on a soft field alone is surfaced in the report
  // for manual review but does NOT change the overall status to "warning".
  // Soft: images, description, dimensions  →  shown in report; a *mismatch* on
  //       any field (including soft ones, e.g. the AI image verdict) still
  //       escalates via hasMismatch below.
  // Pack-qty title mismatches are always hard (never soft-downgraded).
  const hasMismatch = fields.some((f) => f.severity === "mismatch");
  const hasHardWarning = fields.some((f) => f.severity === "warning" && HARD_FIELDS.has(f.field));


  return {
    productId: p.id,
    status: hasMismatch ? "mismatch" : hasHardWarning ? "warning" : "ok",
    fields,
    liveData,
  };
}

/**
 * Returns true if two brand strings refer to the same brand.
 * Handles: string containment, shared keyword (>3 chars), and acronym matching.
 * "BB" ↔ "Barefoot Bungalow", "GHF" ↔ "Greenland Home Fashions", "Ashley" ↔ "Signature Design by Ashley"
 */
function brandsMatch(a: string, b: string): boolean {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (!al || !bl) return true;
  if (bl.includes(al) || al.includes(bl)) return true;

  // Shared keyword (>3 chars): "Ashley Furniture" ↔ "Signature Design by Ashley"
  const words = (s: string) => s.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 3);
  const wb = new Set(words(bl));
  if (words(al).some(w => wb.has(w))) return true;

  // Acronym: "BB" ↔ "Barefoot Bungalow", "GHF" ↔ "Greenland Home Fashions"
  const acronymOf = (short: string, full: string): boolean => {
    const s = short.replace(/[^a-zA-Z]/g, "").toUpperCase();
    if (s.length < 2 || s.length > 8) return false;
    const initials = full.split(/\s+/).filter(w => w.length > 1).map(w => w[0].toUpperCase()).join("");
    return initials === s;
  };
  return acronymOf(al, bl) || acronymOf(bl, al);
}

/**
 * Choose the Walmart search result that is actually the product we asked for,
 * or none at all.
 *
 * Walmart ranks by relevance, not identity: searching "Bon 11-482 Flat Slicker"
 * readily returns "Bon 11-385 English Plugging Chisel" first, because they share
 * a brand and a product family. Accepting `items[0]` is what produced ~1700
 * wrong matches in a real 7k run.
 *
 * Evidence is ranked strongest-first:
 *   1. Barcode equality — definitive. Take it immediately.
 *   2. Model code in the title — a differing same-family code is disqualifying
 *      (that is exactly the sibling-SKU failure), an equal one is strong proof.
 *   3. Title similarity — only as a tiebreak, and only above a floor.
 *
 * Returning null is a legitimate and important outcome: "Walmart has this
 * product under a different barcode" and "Walmart does not carry it" are both
 * better answers than a confidently wrong sibling.
 */
export function pickWalmartCandidate<T extends { name?: string; upc?: string }>(
  vendorName: string,
  vendorUpc: string | null,
  candidates: T[],
): T | null {
  if (!candidates.length) return null;
  const digits = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "");
  const vUpc = digits(vendorUpc);

  // 1. Exact barcode match — nothing outranks this.
  if (vUpc) {
    for (const c of candidates) {
      const cUpc = digits(c.upc);
      if (cUpc && (cUpc.endsWith(vUpc) || vUpc.endsWith(cUpc))) return c;
    }
  }

  let best: T | null = null;
  let bestScore = 0;

  for (const c of candidates) {
    const title = c.name ?? "";
    if (!title) continue;

    // 2. Contradicting barcode. We know our product's UPC; if this candidate
    // publishes a different one, it is a different product — no amount of title
    // similarity redeems that. This catches same-family items with no model code
    // in the title, where word overlap alone cannot tell siblings apart.
    const cUpc = digits(c.upc);
    if (vUpc && cUpc && !cUpc.endsWith(vUpc) && !vUpc.endsWith(cUpc)) continue;

    // 3. Model code. A same-family code that DIFFERS means this is a sibling
    // product, not ours — reject outright regardless of how similar the words
    // are, since sibling titles are nearly identical by construction.
    const conflict = titleCodeConflict(vendorName, title);
    if (conflict) continue;

    const sim = titleSim(vendorName, title);
    // An exact same-family code match is strong evidence; weight it above any
    // similarity score so it wins the selection.
    const codeMatch = titleCodesAgree(vendorName, title);
    const score = codeMatch ? 1 + sim : sim;

    if (score > bestScore) { bestScore = score; best = c; }
  }

  // Floor: without a barcode or model-code confirmation, require meaningful word
  // overlap. Below this the "match" is a guess, and a wrong match is worse than
  // an honest not-found — it ships a bad listing.
  if (best && bestScore < 0.3) return null;
  return best;
}

/** True when both titles carry the same same-family product code (e.g. both 11-174). */
function titleCodesAgree(a: string, b: string): boolean {
  const CODE_RE = /\b(\d{2,4})-(\d{2,4})\b/g;
  const codes = (s: string) => [...s.matchAll(CODE_RE)].map((m) => `${m[1]}-${m[2]}`);
  const ca = codes(a);
  if (!ca.length) return false;
  const cb = new Set(codes(b));
  return ca.some((c) => cb.has(c));
}

/**
 * Detect two DIFFERENT product codes of the same family across a pair of titles.
 *
 * Word-overlap similarity cannot see this: two titles from one manufacturer
 * share the brand and unit words ("bon", "inch") and therefore score as merely
 * borderline, even when their model codes make them plainly different products.
 *
 * Deliberately conservative — it only reports a conflict when:
 *   • both titles contain a hyphenated code like `11-482` (the shape that
 *     denotes a model, as opposed to a bare size or year), and
 *   • the codes share a leading segment (same family, e.g. `11-*`), and
 *   • the trailing segments differ.
 *
 * Requiring a shared family prefix is what keeps this from firing on
 * dimensions ("1-1/4" vs "3-8") or unrelated numbers: those rarely share a
 * prefix with a real model code, and when nothing matches we return null and
 * leave the verdict to the normal similarity scoring.
 */
export function titleCodeConflict(
  vendorTitle: string,
  liveTitle: string,
): { vendor: string; live: string } | null {
  // Codes like 11-482, 21-304, 6200-0056. Require 2+ digits either side so
  // fractions ("1-4", "3-8") and small ranges are not treated as model codes.
  const CODE_RE = /\b(\d{2,4})-(\d{2,4})\b/g;
  const codes = (s: string): [string, string][] =>
    [...s.matchAll(CODE_RE)].map((m) => [m[1], m[2]] as [string, string]);

  const vc = codes(vendorTitle);
  const lc = codes(liveTitle);
  if (!vc.length || !lc.length) return null;

  for (const [vFam, vNum] of vc) {
    for (const [lFam, lNum] of lc) {
      if (vFam !== lFam) continue;      // different families — not comparable
      if (vNum === lNum) return null;    // an exact code match anywhere wins
      return { vendor: `${vFam}-${vNum}`, live: `${lFam}-${lNum}` };
    }
  }
  return null;
}

/** Word overlap fraction for description comparison (uses the smaller set as denominator). */
function wordOverlap(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 3);
  const wa = new Set(norm(a));
  const wb = new Set(norm(b));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  return common / Math.min(wa.size, wb.size);
}

/** Parse a vendor dimension string into [W, D, H] in inches. Handles "72W x 38D x 32H", "72 x 38 x 32", etc. */
function parseDims(s: string): [number, number, number] | null {
  const nums = [...s.matchAll(/(\d+(?:\.\d+)?)/g)].map(m => parseFloat(m[1])).filter(n => n > 0);
  if (nums.length < 3) return null;
  return [nums[0], nums[1], nums[2]];
}

// ── Multi-signal ASIN candidate picker ───────────────────────────────────────
// When Keepa returns multiple ASINs for a single UPC, score each candidate
// across signals and return the highest-scoring one.
// Pack quantity is a hard pre-filter when any same-qty candidates exist.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function pickBestCandidate(p: Product, candidates: any[]): any {
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  // Prefer pack-compatible titles when available (caller should already filter,
  // but keep this as a safety net).
  const packMatched = filterPackCompatible(p.name, candidates);
  const pool = packMatched.length ? packMatched : candidates;

  // Extract vendor price for price-range comparison
  const vdRaw = (p.vendorData as Record<string, unknown> | null) ?? {};

  // Vendor model / part number — the strongest identity signal after the barcode itself
  const vendorModel = extractModelNumber(p.vendorData);
  const vendorPrice = (() => {
    if (p.price != null) return Number(p.price);
    for (const key of ["price", "retail_price", "unit_price", "cost", "msrp", "list_price", "wholesale"]) {
      const v = vdRaw[key];
      if (v != null && !isNaN(Number(v))) return Number(v);
    }
    return null;
  })();

  // Extract vendor category for category-match signal
  const vendorCategory = (() => {
    for (const key of ["category", "Category", "product_category", "item_category", "department", "product_type"]) {
      const v = vdRaw[key];
      if (v && typeof v === "string") return v.toLowerCase();
    }
    return null;
  })();

  const vendorQty = extractPackQty(p.name);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const score = (c: any): number => {
    let s = 0;
    const liveTitle = String(c.title ?? "");
    const liveQty = extractPackQty(liveTitle);

    // Pack qty is hard: huge penalty so multipacks never beat single-unit peers.
    if (vendorQty !== liveQty) {
      s -= 100;
    } else if (vendorQty > 1) {
      s += 40; // explicit pack match — strong bonus
    }

    // 0. Title similarity — critical (weight 50)
    const ts = titleSim(p.name, liveTitle);
    s += ts * 50;

    // 1. Model number match — weight 40 (below pack + title; never overrides pack)
    if (vendorModel) {
      const vm = modelNorm(vendorModel);
      const candModels = [c.model, c.partNumber]
        .filter((m): m is string => typeof m === "string" && !!m.trim())
        .map(modelNorm);
      if (candModels.includes(vm)) s += 40;
      else if (vm.length >= 4 && modelNorm(liveTitle).includes(vm)) s += 20;
    }

    // 2. Brand match — weight 20
    const vendorBrand = (p.brand ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const liveBrand = (c.brand as string ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (vendorBrand && liveBrand) {
      if (vendorBrand === liveBrand) s += 20;
      else if (vendorBrand.includes(liveBrand) || liveBrand.includes(vendorBrand)) s += 10;
    }

    // 3. Price proximity — weight 15
    if (vendorPrice != null && vendorPrice > 0 && c.price != null) {
      const livePrice = (c.price as number) / 100; // Keepa stores cents
      if (livePrice > 0) {
        const ratio = Math.min(vendorPrice, livePrice) / Math.max(vendorPrice, livePrice);
        s += ratio * 15;
      }
    }

    // 4. Category match — weight 10
    if (vendorCategory) {
      const catWords = vendorCategory.split(/[\s,>/]+/).filter((w) => w.length > 3);
      const liveContext = [
        liveTitle,
        c.categoryTree as string ?? "",
        c.rootCategory as string ?? "",
        c.category as string ?? "",
      ].join(" ").toLowerCase();
      const catHits = catWords.filter((w) => liveContext.includes(w)).length;
      if (catWords.length > 0) s += (catHits / catWords.length) * 10;
    }

    // 5. Availability / sales rank — weight 5 (prefer better-ranked singles)
    const rank = c.salesRank as number ?? -1;
    if (rank > 0 && rank < 1_000_000) s += 5;
    else if (rank > 0 && rank < 5_000_000) s += 2;

    return s;
  };

  let best = pool[0];
  let bestScore = score(pool[0]);
  for (const c of pool.slice(1)) {
    const cs = score(c);
    if (cs > bestScore) { bestScore = cs; best = c; }
  }
  return best;
}

/** Keep only candidates whose pack/case qty matches the catalog title. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function filterPackCompatible(vendorTitle: string, candidates: any[]): any[] {
  const vendorQty = extractPackQty(vendorTitle);
  return candidates.filter((c) => extractPackQty(String(c?.title ?? "")) === vendorQty);
}

// ── Pack-quantity helpers ─────────────────────────────────────────────────────
// Extracts the item-count / pack size from a product title.
// No mention → treated as 1 (single unit). Used to flag qty mismatches between
// the vendor title and the live marketplace title (Pack of 6 ≠ Pack of 1).

/**
 * Colour words we recognise in titles, descriptions and attribute fields.
 *
 * Deliberately a fixed vocabulary rather than "any adjective": product titles
 * are full of words that look like colours but are not (a "Silver Series"
 * mixer, "Rose Gold Edition" packaging), and free-form guessing produces more
 * false differences than it resolves. Multi-word entries come first so
 * "rose gold" wins over a bare "gold", and "off white" over "white".
 */
const COLOUR_TERMS = [
  "rose gold", "off white", "navy blue", "sky blue", "royal blue", "light blue",
  "dark blue", "light grey", "dark grey", "light gray", "dark gray",
  "stainless steel", "gun metal", "space gray", "space grey",
  "black", "white", "grey", "gray", "silver", "gold", "bronze", "copper",
  "brass", "chrome", "nickel", "red", "burgundy", "maroon", "pink", "magenta",
  "purple", "violet", "lavender", "blue", "teal", "turquoise", "aqua", "cyan",
  "green", "olive", "lime", "mint", "yellow", "mustard", "orange", "peach",
  "coral", "brown", "tan", "beige", "cream", "ivory", "khaki", "charcoal",
  "natural", "clear", "transparent", "multicolor", "multicolour", "multi color",
  // Shade names marketplaces use where a vendor title says the base colour.
  // canonicalColour() folds each onto its family so they compare equal.
  "taupe", "mocha", "cocoa", "walnut", "almond", "chestnut", "espresso",
  "coffee", "caramel", "hazelnut", "chocolate", "sage", "forest", "emerald",
  "hunter", "crimson", "scarlet", "ruby", "indigo", "cobalt", "denim",
  "blush", "rose", "salmon", "slate", "graphite", "pewter", "sand",
  "oatmeal", "linen",
] as const;

/**
 * Fold colour synonyms onto one canonical term.
 *
 * Vendors and marketplaces name the same shade differently — a "stainless
 * steel" finish is listed as "silver", "grey" and "gray" are spelling variants,
 * "multicolour" has three forms. Comparing the raw strings reported ~700 colour
 * "differences" on a 7k catalog, nearly all of them naming the same colour.
 */
function canonicalColour(c: string): string {
  const SYNONYM: Record<string, string> = {
    "stainless steel": "silver",
    chrome: "silver",
    nickel: "silver",
    // Marketplaces list specific shades where vendor titles say the base colour
    // ("brown" vs "walnut"/"mocha"/"taupe"). Folding shades onto their family
    // removed the largest remaining group of false differences; a genuine
    // brown-vs-blue conflict still reports.
    taupe: "brown", mocha: "brown", cocoa: "brown", walnut: "brown",
    almond: "brown", chestnut: "brown", espresso: "brown", coffee: "brown",
    caramel: "brown", hazelnut: "brown", chocolate: "brown",
    sage: "green", forest: "green", emerald: "green", hunter: "green",
    crimson: "red", scarlet: "red", ruby: "red",
    indigo: "blue", cobalt: "blue", denim: "blue",
    blush: "pink", rose: "pink", salmon: "pink",
    slate: "grey", graphite: "grey", pewter: "grey",
    sand: "beige", oatmeal: "beige", linen: "beige",
    gray: "grey",
    "light gray": "light grey",
    "dark gray": "dark grey",
    "space gray": "grey",
    "space grey": "grey",
    "gun metal": "grey",
    charcoal: "grey",
    multicolour: "multicolor",
    "multi color": "multicolor",
    transparent: "clear",
    ivory: "cream",
    magenta: "pink",
    violet: "purple",
    aqua: "turquoise",
    cyan: "turquoise",
    maroon: "burgundy",
  };
  return SYNONYM[c] ?? c;
}

/**
 * Pull a colour from a product title, description, or marketplace attributes.
 *
 * Checks explicit colour attributes first (the marketplace usually publishes
 * one, and it is authoritative), then falls back to scanning text. Returns the
 * canonical lowercase term, or null when no colour is stated — which is common
 * and is NOT the same as a colour mismatch.
 */
export function extractColour(
  text: string,
  attributes?: Record<string, unknown> | null,
): string | null {
  // 1. An explicit colour attribute beats anything parsed out of prose.
  if (attributes) {
    for (const [k, v] of Object.entries(attributes)) {
      if (!/\bcolou?r\b/i.test(k)) continue;
      const val = String(v ?? "").trim().toLowerCase();
      if (!val) continue;
      // "Multi-color" is Walmart's catch-all for "we didn't categorise this",
      // not a claim about the product. Treating it as a colour produced a large
      // batch of false differences (e.g. stainless steel vs multi-color), so
      // read it as "not stated" and fall through to the text scan.
      if (/^multi[\s-]?colou?r(ed)?$/.test(val) || val === "assorted" || val === "various") break;
      const known = COLOUR_TERMS.find((c) => val === c || val.includes(c));
      if (known) return canonicalColour(known);
      // An unrecognised attribute value is still the marketplace's stated
      // colour — report it rather than pretending none exists.
      if (val.length <= 30) return val;
    }
  }

  // 2. Scan the text. Word boundaries keep "redwood" from matching "red".
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;
  for (const c of COLOUR_TERMS) {
    if (t.includes(` ${c} `)) return canonicalColour(c);
  }
  return null;
}

export function extractPackQty(title: string, description = ""): number {
  // Check title first, then description as fallback
  for (const src of [title, description].filter(Boolean)) {
    const t = src.toLowerCase();
    const patterns: RegExp[] = [
      /pack[- ]?of[- ]?(\d+)/,             // "pack of 6", "pack-of-6", "pack of5"
      /\(\s*pack[- ]?of[- ]?(\d+)\s*\)/,   // "(Pack of 5)"
      /(\d+)[- ]?pack\b/,                  // "6-pack", "6 pack", "6pack"
      /(?:wholesale\s+)?case[- ]?of[- ]?(\d+)/, // "case of 10", "Wholesale CASE of 10"
      /(\d+)[- ]?case\b/,                  // "10-case", "10 case"
      /set[- ]?of[- ]?(\d+)/,              // "set of 3", "set of3"
      /(\d+)[- ]?(?:pieces?|pcs?)\b/,      // "6 pieces", "6 pcs", "6pc"
      /(\d+)[- ]?(?:count|ct)\b/,          // "6 count", "6ct"
      /(\d+)[- ]?pk\b/,                    // "6pk", "6-pk"
      /box[- ]?of[- ]?(\d+)/,              // "box of 12", "box of12"
      /bundle[- ]?of[- ]?(\d+)/,           // "bundle of 4", "bundle of4"
      /multipack[- ]?of[- ]?(\d+)/,        // "multipack of 3"
      /(\d+)[- ]units?\b/,                 // "6 units"
      /qty[: ]+(\d+)/,                     // "qty: 6"
      /\((\d+)\s*(?:pack|count|ct|pk|pcs?|pieces?|case)\)/, // "(6 pack)", "(12 ct)", "(5 case)"
    ];
    for (const re of patterns) {
      const m = t.match(re);
      if (m) return parseInt(m[1]!, 10);
    }
  }
  return 1;
}

// ── Model-number helpers ──────────────────────────────────────────────────────
// Extracts a model / part number from raw vendor spreadsheet data.

/** Normalize a model/part number for comparison: lowercase, strip separators. */
function modelNorm(s: string): string {
  return s.toLowerCase().replace(/[\s\-_\/.]+/g, "");
}

const MODEL_NUMBER_KEYS = [
  "model", "modelnumber", "modelno", "modelnum",
  "mpn", "manufacturerpartnumber", "mfrpartno",
  "partnumber", "partno", "partnum",
  "itemmodelnumber",
];

export function extractModelNumber(vendorData: unknown): string | null {
  if (!vendorData || typeof vendorData !== "object") return null;
  const vd = vendorData as Record<string, unknown>;
  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-#.]+/g, "");
  for (const [k, v] of Object.entries(vd)) {
    if (MODEL_NUMBER_KEYS.includes(norm(k))) {
      if (v && typeof v === "string") {
        const val = v.trim();
        // Require at least one digit or separator character so that plain vehicle/product
        // names like "Tacoma" (from a "Compatible Model" column) are not mistaken for
        // part numbers. Real model numbers (6200-0056, B2-19FC, AX.1000) always have one.
        if (val && !val.startsWith("http") && (/\d/.test(val) || /[-_\/\.]/.test(val))) return val;
      }
    }
  }
  return null;
}

// Common retail abbreviation synonyms — both directions are registered
const SYNONYMS: Record<string, string> = {
  tv: "television", television: "tv",
  pc: "computer", computer: "pc",
  ac: "airconditioner", airconditioner: "ac",
  wifi: "wireless", wireless: "wifi",
  bt: "bluetooth", bluetooth: "bt",
  usb: "universal", pkg: "package",
  qty: "quantity", pcs: "pieces", pieces: "pcs",
  sz: "size", xl: "extralarge", lg: "large", sm: "small", md: "medium",
  blk: "black", wht: "white", gry: "gray", grey: "gray",
  pwr: "power", strp: "strip", ext: "extension",
  hdmi: "highdefinition", led: "light", lcd: "display",
  fridge: "refrigerator", refrigerator: "fridge",
  sofa: "couch", couch: "sofa",
  stool: "chair", barstool: "stool",
  // Automotive running boards / steps
  sidestep: "runningboard", runningboard: "sidestep",
  nerfbar: "runningboard", stepbar: "runningboard",
  sideboard: "runningboard", stepboard: "runningboard",
  // Home / furniture
  comforter: "bedding", quilt: "bedding", duvet: "bedding",
  loveseat: "sofa", sectional: "sofa",
  dresser: "chest", armoire: "wardrobe", wardrobe: "armoire",
  rug: "carpet", carpet: "rug",
};

function normalizeTitle(s: string): Set<string> {
  const STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "are", "was", "has"]);
  const tokens = s.toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
  const result = new Set<string>();
  for (const t of tokens) {
    result.add(t);
    if (SYNONYMS[t]) result.add(SYNONYMS[t]);
  }
  return result;
}

function titleSim(a: string, b: string): number {
  const wa = normalizeTitle(a);
  const wb = normalizeTitle(b);
  if (!wa.size) return !wb.size ? 1 : 0;
  // Jaccard similarity: |intersection| / |union| — symmetric, works both ways
  let common = 0;
  for (const w of wa) if (wb.has(w)) common++;
  const union = wa.size + wb.size - common;
  const jaccard = union > 0 ? common / union : 0;
  // Also compute recall (how much of 'a' is in 'b') as secondary signal
  const recall = common / wa.size;
  // Weighted blend: 60% Jaccard + 40% recall
  return jaccard * 0.6 + recall * 0.4;
}
