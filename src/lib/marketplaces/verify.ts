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
 */
export async function applyAiVerificationPasses(
  results: VerifyResult[],
  products: Product[],
  marketplace: string,
): Promise<void> {
  await applyImageComparison(results, products);
  if (marketplace === "walmart") await applySemanticTitleCheck(results, products);
}

// ── AI image comparison post-pass ─────────────────────────────────────────────
// For every result where both a catalog image and a marketplace image exist,
// ask a vision model whether they show the same product, then upgrade the
// "images" field from the default "warning" to "ok" (visual match) or
// "mismatch" (visibly different product). "unsure" keeps the manual-review
// warning. Degrades gracefully: without an API key nothing changes.

async function applyImageComparison(results: VerifyResult[], products: Product[]): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) return;

  const isUrl = (v: string | undefined): v is string => !!v && v.startsWith("http");
  const nameById = new Map(products.map((p) => [p.id, p.name]));

  type Target = { result: VerifyResult; field: FieldResult; liveImageUrls: string[] };
  const targets: Target[] = [];
  for (const r of results) {
    const field = r.fields.find((f) => f.field === "images");
    if (!field || !isUrl(field.stored)) continue;
    // Compare ONLY against the primary marketplace image (images[0]) — the exact
    // shot the UI shows as the thumbnail (see field.liveImage = liveImages[0]).
    // Comparing extra angles flagged alternate views (e.g. a back shot) the
    // reviewer never sees, producing "images differ" on rows that look identical
    // on screen. The verdict must match what the user is actually looking at.
    const liveImages = Array.isArray(r.liveData.images) ? r.liveData.images as string[] : [];
    const liveImageUrls = liveImages.filter(isUrl).slice(0, 1);
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

  // Hard fields: only title / brand / model mismatches escalate overall status to "mismatch".
  // Images are a soft field — an AI color-variant difference (e.g. stainless vs black)
  // shows as "mismatch" on the images row for manual review, but the overall product
  // status only rises to "warning" so genuine matching products aren't falsely flagged.
  const HARD_FIELDS = new Set(["title", "brand", "model"]);
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
  if (!process.env.ANTHROPIC_API_KEY) return;

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
  const { createAnthropic } = await import("@ai-sdk/anthropic");
  const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.DEFAULT_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

  const CONCURRENCY = 5;
  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (t) => {
      try {
        const { text } = await generateText({
          model: anthropic(model),
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
        // Recompute overall status
        const HARD_FIELDS = new Set(["title", "brand", "model"]);
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

async function verifyWalmart(products: Product[]): Promise<VerifyResult[]> {
  const { searchWalmartByUpc, searchWalmartByName } = await import("@/lib/walmart/client");
  const { getSellerItemByGtin, sellerApiConfigured } = await import("@/lib/walmart/seller-client");
  // The Affiliate API only reliably indexes Walmart's first-party retail
  // catalog, so our own freshly-published seller listings often come back empty
  // there even while live on walmart.com. The Seller API reads OUR catalog
  // directly, so a GTIN hit here authoritatively confirms our listing — this is
  // the primary lookup, with the Affiliate search kept as a fallback.
  const useSellerApi = sellerApiConfigured();
  // The affiliate API parallelises near-linearly: measured 1 call ≈ 24 concurrent
  // calls ≈ 1.4s, with no throttling. 12 keeps a wide safety margin under that
  // ceiling while cutting the lookup phase ~4x versus the previous value of 3.
  const CONCURRENCY = 12;

  // Mark discontinued products immediately
  const discontinuedResults: VerifyResult[] = products
    .filter((p) => isDiscontinuedInVendorData(p.vendorData))
    .map((p) => ({ productId: p.id, status: "discontinued" as const, fields: [], liveData: {} }));
  const activeProducts = products.filter((p) => !isDiscontinuedInVendorData(p.vendorData));

  const results: VerifyResult[] = [];

  for (let i = 0; i < activeProducts.length; i += CONCURRENCY) {
    const batch = activeProducts.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(async (p) => {
      let item = null;

      // Primary: confirm our OWN published listing via the Seller API by GTIN.
      if (useSellerApi && p.upc) {
        const seller = await getSellerItemByGtin(p.upc).catch(() => null);
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

      if (p.upc) {
        // Try UPC-based lookup first; fall back to name search if Walmart doesn't index by UPC.
        // Some legitimate products (especially newer listings) aren't indexed by UPC yet.
        item = await searchWalmartByUpc(p.upc).catch(() => null);
        if (!item) {
          // UPC lookup returned nothing — try name-based search so we don't miss the product.
          // A title similarity check in compareToLive will surface any mismatch.
          const query = [p.brand, p.name].filter(Boolean).join(" ").trim();
          item = await searchWalmartByName(query).catch(() => null);
          if (!item && p.name) item = await searchWalmartByName(p.name).catch(() => null);
        }
      } else {
        // No UPC — try brand + name, then name alone
        const query = [p.brand, p.name].filter(Boolean).join(" ").trim();
        item = await searchWalmartByName(query).catch(() => null);
        if (!item && p.name) item = await searchWalmartByName(p.name).catch(() => null);
      }

      if (!item) return notFound(p.id);

      const priceInCents = item.salePrice != null ? Math.round(item.salePrice * 100) : null;
      // Build Walmart product page URL from itemId (not the image URL)
      const slug = (item.name ?? "product")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
      const walmartProductUrl = item.itemId
        ? `https://www.walmart.com/ip/${slug}/${item.itemId}`
        : "";

      // Collect ALL image angles: imageEntities (all secondary/primary shots) + fallback top-level fields.
      // The AI visual comparison will pick the best-matching angle, improving accuracy.
      const entityImages = (item.imageEntities ?? [])
        .map((e) => e.largeImage ?? e.thumbnailImage)
        .filter((u): u is string => !!u && u.startsWith("http"));
      const allImages = [
        ...entityImages,
        item.largeImage,
        item.thumbnailImage,
      ].filter((u): u is string => !!u && u.startsWith("http"))
       .filter((u, i, arr) => arr.indexOf(u) === i); // deduplicate

      const liveDataForCompare = {
        ...item,
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
    }));

    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      results.push(s.status === "fulfilled" ? s.value : notFound(batch[j].id));
    }
  }

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
  if (vendorUpc) {
    const upcMatch = liveUpc ? vendorUpc.replace(/\D/g, "").endsWith(liveUpc.replace(/\D/g, "")) ||
      liveUpc.replace(/\D/g, "").endsWith(vendorUpc.replace(/\D/g, "")) : false;
    // An absent live UPC is "could not verify", NOT a pass — previously this was
    // reported as ok/match, so unverified products looked identical to confirmed
    // matches in the report. Surface it as a warning with an explicit note.
    fields.push({
      field: "upc", label: "UPC",
      stored: vendorUpc, live: liveUpc || "N/A",
      match: upcMatch,
      severity: upcMatch ? "ok" : "warning",
      ...(liveUpc
        ? (upcMatch ? {} : { note: "Vendor UPC does not match the marketplace UPC" })
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
  const brandMatch = !p.brand || !liveBrand
    || brandsMatch(p.brand, liveBrand)
    || liveBrandInVendorTitle
    || vendorBrandInLiveTitle;
  fields.push({ field: "brand", label: "Brand", stored: p.brand ?? "N/A", live: liveBrand ?? "N/A", match: brandMatch, severity: brandMatch ? "ok" : "warning" });

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
  // "ok" only when no vendor image (nothing to compare); "warning" when both exist (needs visual review);
  // "warning" when vendor has image but live has none.
  const imgSeverity: "ok" | "warning" = !hasVendorImage ? "ok" : "warning";
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
  // Hard: title, brand, model  →  any warning/mismatch here = escalates status
  // Soft: images, description, dimensions  →  shown in report; image *mismatch*
  //       (from AI) still escalates via hasMismatch below.
  // Pack-qty title mismatches are always hard (never soft-downgraded).
  const HARD_FIELDS = new Set(["title", "brand", "model"]);
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
