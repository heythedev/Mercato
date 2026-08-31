import { resolveSkuFromCatalog, hasCatalogVendor, type CatalogEntry } from "./vendor-catalog";

/**
 * Is any usable web-search provider configured?
 *
 * Without a SerpAPI key the only remaining backend is DuckDuckGo's HTML endpoint, which
 * serves a bot-challenge (HTTP 202) to servers and returns ZERO results. Pursuing it
 * still pays the full timeout for every query variant of every product — ~40s per SKU
 * that finds nothing. For a 2000-row SKU-only sheet that is ~2 hours of pure dead wait,
 * which is why categorization "failed after 30 min". When no real provider exists we
 * skip web search entirely and let the AI categorize from the raw code instead.
 */
const WEB_SEARCH_AVAILABLE = !!process.env.SERPAPI_KEY;

export type SkuProductInput = {
  id: string;
  name: string;
  brand: string | null;
  description: string | null;
  sku?: string | null;
  vendorCategory?: string | null;
  vendorContext?: string | null;
};

/**
 * Deterministic product-type hint derived from a vendor SKU's structure, used ONLY as a
 * last resort when the code could not be resolved to a real title (the SKU is discontinued
 * or simply absent from the vendor's public catalog).
 *
 * This never invents a specific product — it supplies the product FAMILY the SKU prefix
 * always denotes, so a code the AI would otherwise flag "No match" still lands in the right
 * broad category. Modway's rug SKUs are always "R-####-…" (verified across the whole
 * catalog: every R-#### resolved to a Rugs entry), so an unresolved "MODA-R1102A58" is
 * still, unambiguously, a rug.
 */
function skuCategoryHint(sku: string): string | null {
  const s = sku.toUpperCase();
  // Modway rugs: MODA-R#### / R-#### (the "R" family is exclusively area rugs)
  if (/^(?:MODA-?)?R-?\d{3,}/.test(s)) return "rug / area rug";
  return null;
}

export type SkuEnrichment = {
  productId: string;
  name: string;
  brand: string | null;
  description: string | null;
  searchContext: string;
  /**
   * Catalog attributes to merge into the product's vendorData so the export template can
   * fill Size / Color / image / weight columns. The vendor sheet was bare SKUs, so these
   * are the only source for those columns. Keys are human column-ish names (Color, Rug
   * Size, Image URL 1…) that the export field resolver already understands.
   */
  attributes?: Record<string, string>;
};

/**
 * Turn a catalog entry into vendorData-style attributes the export template can fill.
 * The Shopify option names vary (Size/Color/…); each is mapped onto both the generic
 * name and the marketplace's column labels so the export field resolver matches either.
 * Keys are the human column labels the Mathis template uses (Rug Size, SILO Image,
 * Image URL 1…), which normalize-match the template headers.
 */
export function catalogEntryToAttributes(entry: CatalogEntry): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const [optName, optVal] of Object.entries(entry.options)) {
    attributes[optName] = optVal; // e.g. "Size": "8x10", "Color": "Blue and Ivory"
    const lo = optName.toLowerCase();
    if (lo === "size") { attributes["Rug Size"] = optVal; }
    if (lo === "color" || lo === "colour") { attributes["Upholstery Color"] = optVal; }
  }

  // The catalog's image list spans EVERY variant (all colorways of the product). Prefer
  // the images whose filename carries this variant's SKU (Modway names files
  // "R-1129B-810_7_….jpg") so an 8x10 blue rug doesn't get the beige rug's photos.
  const skuToken = entry.sku.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const variantImages = skuToken
    ? entry.images.filter((u) => u.replace(/[^a-z0-9]/gi, "").toLowerCase().includes(skuToken))
    : [];
  const images = variantImages.length ? variantImages : entry.images;

  images.slice(0, 10).forEach((url, i) => { attributes[`Image URL ${i + 1}`] = url; });
  const silo = images[0] ?? entry.image;
  if (silo) attributes["SILO Image"] = silo;
  if (entry.grams) attributes["Product Weight"] = (entry.grams / 453.592).toFixed(2); // g → lb
  return attributes;
}

export type CatalogAttributeFill = {
  /** Main image for the product row (SILO / Image 1); null when the catalog has none. */
  imageUrl: string | null;
  /**
   * Real product title/brand/description from the vendor catalog. Callers apply these
   * only to rows whose stored name is still a raw SKU code (see looksLikeSkuName) —
   * a resolved human name must never be overwritten by a re-fetch.
   */
  title: string | null;
  brand: string | null;
  description: string | null;
  /** vendorData-style attributes (images, size, color, weight) — see catalogEntryToAttributes. */
  attributes: Record<string, string>;
};

/**
 * EXPORT-TIME catalog fill: resolve images + attributes for products that lack them.
 *
 * Enrichment during categorization only runs for rows whose name still looks like a raw
 * SKU code. Once a run has resolved the names, re-categorizing skips those rows — so a
 * project enriched before attribute support existed permanently missed its images. The
 * export must not depend on that ordering: this fill runs right before the template is
 * written and back-fills anything a registered vendor catalog can provide.
 *
 * Only products that carry a catalog-vendor SKU and are missing an image — or whose
 * name is still the raw vendor code — are touched; everything else passes through with
 * zero network cost.
 */
export async function fillCatalogAttributes(
  products: Array<{
    id: string;
    name?: string | null;
    vendorSku?: string | null;
    imageUrl?: string | null;
    vendorData?: unknown;
  }>,
  onProgress?: (done: number, total: number) => void,
  opts?: {
    /**
     * Absolute Date.now() timestamp to stop at. A SKU-only sheet can need
     * hundreds of catalog scrapes; inside a time-limited serverless function
     * the sweep must yield rather than outlive its host. Partial results are
     * fine — callers persist fills, so the next run resumes where this stopped.
     */
    deadline?: number;
  },
): Promise<Map<string, CatalogAttributeFill>> {
  const out = new Map<string, CatalogAttributeFill>();

  const needsFill = products.filter((p) => {
    const sku = p.vendorSku?.trim();
    if (!sku || !hasCatalogVendor(sku)) return false;
    // A row whose name is still the raw vendor code needs the catalog even when its
    // images are already filled — otherwise the exported Name column shows the code.
    if (p.name && looksLikeSkuName(p.name, sku)) return true;
    if (p.imageUrl && String(p.imageUrl).startsWith("http")) {
      // Already has a main image — only re-fill if the numbered image columns are absent.
      const vd = (p.vendorData ?? {}) as Record<string, unknown>;
      const hasImgCols = Object.entries(vd).some(
        ([k, v]) => /image/i.test(k) && String(v ?? "").startsWith("http"),
      );
      return !hasImgCols;
    }
    return true;
  });
  if (!needsFill.length) return out;

  const PARALLEL = Number(process.env.SKU_ENRICH_PARALLELISM ?? 10);
  let done = 0;
  for (let i = 0; i < needsFill.length; i += PARALLEL) {
    if (opts?.deadline && Date.now() > opts.deadline) {
      console.warn(
        `[catalog] back-fill time budget hit at ${done}/${needsFill.length} — remaining products fill on the next run`,
      );
      break;
    }
    const slice = needsFill.slice(i, i + PARALLEL);
    await Promise.all(
      slice.map(async (p) => {
        try {
          const entry = await resolveSkuFromCatalog(p.vendorSku!.trim());
          if (!entry) return;
          const attributes = catalogEntryToAttributes(entry);
          out.set(p.id, {
            imageUrl: attributes["SILO Image"] ?? entry.image ?? null,
            title: entry.title || null,
            brand: entry.brand || null,
            description: entry.description || null,
            attributes,
          });
        } catch { /* leave this product as-is */ }
      }),
    );
    done += slice.length;
    onProgress?.(Math.min(done, needsFill.length), needsFill.length);
  }
  return out;
}

/**
 * True when the "name" is really a vendor code (SKU sheet uploads), not a product title.
 * Examples: TOVF-TOVL54566, ABC-12345, SKU1234
 */
export function looksLikeSkuName(name: string, vendorSku?: string | null): boolean {
  const n = name.trim();
  if (!n) return true;
  if (vendorSku && n.toLowerCase() === vendorSku.trim().toLowerCase()) return true;

  // Alphanumeric code with optional separators, short word count, no spaces (or one hyphenated token)
  const compact = /^[A-Z0-9][A-Z0-9._/-]{2,39}$/i.test(n);
  const words = n.split(/\s+/).filter(Boolean);
  if (compact && words.length <= 2) return true;

  // Mostly digits / codes rather than English words
  const letters = (n.match(/[a-zA-Z]{3,}/g) ?? []).length;
  const hasSpaces = /\s/.test(n);
  if (!hasSpaces && letters <= 1 && /[0-9]{3,}/.test(n)) return true;

  return false;
}

/**
 * Emit catalog-style variants for a single vendor code segment.
 * Handles the TOV Furniture MPN style: <prefix><seriesLetter><digits><optional suffix>
 * e.g. "TOVL54566" → "TOV-L54566", "TOVT54304FBMP" → "TOV-T54304" (drops the FBMP suffix),
 * and the generic "ABC12345" → "ABC-12345".
 */
function segmentVariants(seg: string): string[] {
  const out: string[] = [];
  const s = seg.trim();
  if (!s) return out;

  // <letters><seriesLetter><4+ digits><optional trailing letters>
  // Non-greedy prefix so the char right before the digits is treated as the series letter.
  const series = s.match(/^([A-Za-z]+?)([A-Za-z])(\d{4,})([A-Za-z]*)$/);
  if (series) {
    out.push(`${series[1]}-${series[2].toUpperCase()}${series[3]}`);
  }

  // ABC12345[SUFFIX] → ABC-12345 (strip any trailing alpha suffix like FBMP)
  const splitDigits = s.match(/^([A-Za-z]{2,})(\d{4,})[A-Za-z]*$/);
  if (splitDigits) out.push(`${splitDigits[1]}-${splitDigits[2]}`);

  return out;
}

/** Search variants so "TOVF-TOVL54566" also tries "TOV-L54566" and "TOVF-TOVT54304FBMP" tries "TOV-T54304". */
export function skuSearchVariants(sku: string): string[] {
  const s = sku.trim();
  if (!s) return [];
  const out = new Set<string>([s]);

  const parts = s.split(/[-_/]/).filter(Boolean);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]!;
    out.add(last);

    for (const v of segmentVariants(last)) out.add(v);

    // Prefer last segment if first looks like a brand prefix (TOVF, APSA, …)
    if (/^[A-Z]{2,6}F?$/i.test(parts[0]!)) {
      out.add(parts.slice(1).join("-"));
    }
  } else {
    for (const v of segmentVariants(s)) out.add(v);
  }

  // Prefer catalog-style codes (contain a hyphen) before raw vendor codes
  return [...out].sort((a, b) => {
    const score = (v: string) => (/-/.test(v) && /\d{4,}/.test(v) ? 0 : v.includes("-") ? 1 : 2);
    return score(a) - score(b) || a.length - b.length;
  });
}

function decodeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

type SearchHit = { title: string; snippet: string };

let serpAuthWarned = false;

async function searchSerpApi(query: string): Promise<SearchHit[]> {
  const key = process.env.SERPAPI_KEY;
  if (!key) return [];
  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&engine=google&api_key=${key}&num=5`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      // An invalid/expired key silently zeroes out ALL web SKU resolution —
      // say so once, loudly, instead of every row just reading "No match".
      if ((res.status === 401 || res.status === 403) && !serpAuthWarned) {
        serpAuthWarned = true;
        console.warn(
          `[resolve-sku] SerpAPI rejected the key (HTTP ${res.status}) — ` +
            `web SKU resolution is OFF until SERPAPI_KEY is fixed`,
        );
      }
      return [];
    }
    const data = (await res.json()) as { organic_results?: { title?: string; snippet?: string }[] };
    return (data.organic_results ?? [])
      .slice(0, 5)
      .map((r) => ({ title: (r.title ?? "").trim(), snippet: (r.snippet ?? "").trim() }))
      .filter((h) => h.title);
  } catch {
    return [];
  }
}

const BROWSER_UA = "Mozilla/5.0";

async function searchDuckDuckGo(query: string): Promise<SearchHit[]> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(10000),
    });
    // 202 = bot challenge page (no results)
    if (!res.ok || res.status === 202) return [];
    const html = await res.text();
    if (!html.includes("result__a")) return [];
    const titles = [...html.matchAll(/class="result__a"[^>]*>([^<]+)</g)].map((m) => decodeHtml(m[1] ?? ""));
    const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)].map((m) =>
      decodeHtml((m[1] ?? "").replace(/<[^>]+>/g, "")),
    );
    const hits: SearchHit[] = [];
    for (let i = 0; i < Math.min(titles.length, 5); i++) {
      hits.push({ title: titles[i]!, snippet: snippets[i] ?? "" });
    }
    return hits.filter((h) => h.title);
  } catch {
    return [];
  }
}

/** TOV Furniture vendor codes (TOVF-TOVL##### / TOV-L#####) → tovfurniture.com search. */
function isTovLikeSku(sku: string): boolean {
  return /\btov/i.test(sku);
}

async function searchTovFurniture(query: string): Promise<SearchHit[]> {
  try {
    const url = `https://tovfurniture.com/search?q=${encodeURIComponent(query)}&type=product`;
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return [];
    const html = await res.text();

    // Product handles ranked by Shopify search (_pos=)
    const handles = [...html.matchAll(/\/products\/([a-z0-9-]+)\?[^"]*_pos=(\d+)/gi)]
      .map((m) => ({ handle: m[1]!, pos: Number(m[2]) }))
      .filter((h) => h.handle && !/gift-card|baseball-cap/i.test(h.handle))
      .sort((a, b) => a.pos - b.pos);

    const uniqueHandles = [...new Set(handles.map((h) => h.handle))].slice(0, 3);
    const hits: SearchHit[] = [];

    for (const handle of uniqueHandles) {
      try {
        const pRes = await fetch(`https://tovfurniture.com/products/${handle}.json`, {
          headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (!pRes.ok) continue;
        const data = (await pRes.json()) as {
          product?: { title?: string; vendor?: string; body_html?: string; variants?: { sku?: string }[] };
        };
        const product = data.product;
        if (!product?.title) continue;
        const skus = (product.variants ?? []).map((v) => v.sku).filter(Boolean).join(", ");
        const desc = decodeHtml((product.body_html ?? "").replace(/<[^>]+>/g, " ")).slice(0, 220);
        hits.push({
          title: `${product.title} | TOV Furniture`,
          snippet: [product.vendor ? `Brand: ${product.vendor}` : null, skus ? `SKU: ${skus}` : null, desc]
            .filter(Boolean)
            .join(". "),
        });
      } catch {
        /* try next handle */
      }
    }

    if (hits.length) return hits;

    // Fallback: card heading text on the search page
    const cardTitles = [...html.matchAll(/class="[^"]*(?:card__heading|full-unstyled-link)[^"]*"[^>]*>([\s\S]*?)<\//gi)]
      .map((m) => decodeHtml((m[1] ?? "").replace(/<[^>]+>/g, "")))
      .filter((t) => t.length > 4 && !/gift card|baseball/i.test(t));
    return [...new Set(cardTitles)].slice(0, 3).map((title) => ({
      title: `${title} | TOV Furniture`,
      snippet: `SKU search: ${query}`,
    }));
  } catch {
    return [];
  }
}

async function searchWeb(query: string, originalSku: string): Promise<SearchHit[]> {
  // Vendor-specific catalog first for TOV codes (most reliable for Mathis furniture sheets).
  // For TOV codes we ONLY trust the TOV catalog: a generic web fallback tends to return
  // loose brand matches (e.g. "TOV" → "TOTO toilet parts"), which mislabels the product.
  // Better to leave it unresolved and let categorization handle it than to overwrite with junk.
  if (isTovLikeSku(originalSku) || isTovLikeSku(query)) {
    return searchTovFurniture(query);
  }
  const serp = await searchSerpApi(query);
  if (serp.length) return serp;
  return searchDuckDuckGo(query);
}

/** Pure-alpha words ≥3 chars — excludes vendor codes like "H1PLR000". */
function realWordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /^[a-zA-Z][a-zA-Z'&-]{2,}$/.test(w)).length;
}

/**
 * The informative half of a pipe-separated retailer title. "Vickerman H1PLR000
 * | 36" Ivory Plume Reed Bundle 7oz" describes the product AFTER the pipe —
 * taking segment 0 unconditionally resolved such rows to "Brand CODE", which
 * is no better than the raw code. Pick the segment with the most real words.
 */
function bestTitleSegment(raw: string): string {
  const segs = raw.split("|").map((s) => s.trim()).filter(Boolean);
  if (segs.length <= 1) return raw.trim();
  return segs.reduce((a, b) => (realWordCount(b) > realWordCount(a) ? b : a));
}

export function pickProductName(hits: SearchHit[], sku: string): string | null {
  const skuNorm = sku.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const hit of hits) {
    // Prefer titles that look like real product names (have spaces / words)
    const title = bestTitleSegment(hit.title);
    if (!title || title.length < 8) continue;
    const words = title.split(/\s+/).filter((w) => /[a-zA-Z]{3,}/.test(w));
    if (words.length < 2) continue;
    // Skip pure navigational / brand-home pages
    if (/^(home|shop|cart|login|instagram)\b/i.test(title)) continue;
    // Prefer hits that mention the SKU (or a close variant) in title/snippet
    const blob = `${hit.title} ${hit.snippet}`.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (skuNorm.length >= 6 && blob.includes(skuNorm.slice(-6))) return title;
    if (words.length >= 2) return title;
  }
  return (hits[0] ? bestTitleSegment(hits[0].title) : "") || null;
}

/**
 * The identity bar a web hit must clear before its title is trusted: some
 * ≥6-char normalized VARIANT of the sheet code appears in the results text, or
 * the code's non-degenerate digit core appears as a bounded number.
 *
 * Variants matter because retailer pages list the vendor's own form of the
 * code — "H1PLR000", never the sheet's "VICK-H1PLR000" — so requiring the full
 * sheet code rejected every genuine hit. Degenerate cores ("000", "1111")
 * appear in any page and prove nothing on their own.
 */
export function hitsReferenceSku(blob: string, sku: string, variants: string[]): boolean {
  const skuCore = (sku.match(/\d{4,}/g) ?? []).pop();
  const isDegenerate = !!skuCore && /^(\d)\1+$/.test(skuCore);
  const hitDigitTokens = new Set(blob.match(/\d+/g) ?? []);
  const normBlob = blob.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const variantTokens = variants
    .map((v) => v.toUpperCase().replace(/[^A-Z0-9]/g, ""))
    .filter((v) => v.length >= 6);
  return (
    (!!skuCore && !isDegenerate && hitDigitTokens.has(skuCore)) ||
    variantTokens.some((v) => normBlob.includes(v))
  );
}

function guessBrand(hits: SearchHit[], name: string | null): string | null {
  const blob = `${name ?? ""} ${hits.map((h) => h.title).join(" ")}`;
  if (/\bTOV\b/i.test(blob) || /tovfurniture/i.test(blob)) return "TOV Furniture";
  const m = blob.match(/\bby\s+([A-Z][A-Za-z0-9&' ]{1,40})\b/);
  return m?.[1]?.trim() || null;
}

/**
 * Resolve SKU-only product rows to real titles/descriptions via web search
 * so Mathis (and other) categorization has something to match against.
 */
export async function enrichSkuOnlyProducts(
  products: SkuProductInput[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ products: SkuProductInput[]; enrichments: SkuEnrichment[] }> {
  const enrichments: SkuEnrichment[] = [];
  const out: SkuProductInput[] = [];

  // Enrichment is network-bound (catalog + product-page fetch), so run more of it at
  // once. The catalog index is cached after the first hit, so the remaining cost is the
  // per-product breadcrumb fetch; 10-wide keeps a large SKU-only sheet from crawling.
  const PARALLEL = Number(process.env.SKU_ENRICH_PARALLELISM ?? 10);
  const queue = products.map((p, idx) => ({ p, idx }));
  const results = new Array<SkuProductInput>(products.length);
  let done = 0;

  for (let i = 0; i < queue.length; i += PARALLEL) {
    const slice = queue.slice(i, i + PARALLEL);
    await Promise.all(
      slice.map(async ({ p, idx }) => {
        // Resolution key: the vendor SKU column is authoritative. Fall back to the product
        // name only when it still looks like a raw code (never resolved yet). Using vendorSku
        // means re-runs self-heal even if a prior bad run overwrote `name` with a wrong title.
        const sku = (p.sku && p.sku.trim()) || (looksLikeSkuName(p.name) ? p.name.trim() : "");
        if (!sku) {
          results[idx] = p;
          return;
        }

        // 1. Authoritative first: match the vendor SKU against the vendor's own Shopify
        //    catalog index (exact / digit-core). No guessing, no mislabels.
        const catalogEntry = await resolveSkuFromCatalog(sku);
        if (catalogEntry) {
          // Category signals from the vendor itself, most authoritative first:
          //  - `category`: the vendor's canonical breadcrumb (e.g. "Bedroom Furniture") — the
          //    single primary category the vendor files it under (resolves multi-room ambiguity).
          //  - `tags`: supporting product-type signals (e.g. "Placemats, Tabletop").
          const tagHint = catalogEntry.tags.length ? catalogEntry.tags.join(", ") : null;
          const primaryCategory = catalogEntry.category
            ? [catalogEntry.category, tagHint].filter(Boolean).join(" | ")
            : tagHint;

          const attributes = catalogEntryToAttributes(catalogEntry);

          const enrichment: SkuEnrichment = {
            productId: p.id,
            name: catalogEntry.title,
            brand: catalogEntry.brand || p.brand,
            description: catalogEntry.description || p.description,
            searchContext: `catalog: ${catalogEntry.sku} | ${catalogEntry.title}`,
            attributes: Object.keys(attributes).length ? attributes : undefined,
          };
          enrichments.push(enrichment);
          results[idx] = {
            ...p,
            name: catalogEntry.title,
            brand: catalogEntry.brand || p.brand,
            description: catalogEntry.description || p.description,
            vendorCategory: primaryCategory ?? p.vendorCategory,
            vendorContext: [
              p.vendorContext,
              `resolved_from_sku: ${sku}`,
              `catalog_sku: ${catalogEntry.sku}`,
              catalogEntry.category ? `vendor_primary_category: ${catalogEntry.category}` : null,
              tagHint ? `vendor_tags: ${tagHint}` : null,
            ]
              .filter(Boolean)
              .join("; "),
          };
          return;
        }

        // 2. Fallback: web search variants (generic / non-catalog vendors).
        //    Only pursue this when the name itself still looks like a code — never overwrite
        //    an already-resolved, human-readable name with a loose web guess.
        if (!looksLikeSkuName(p.name, p.sku)) {
          results[idx] = p;
          return;
        }

        // Skip web search when it can't produce anything (no SerpAPI key — a
        // dead DuckDuckGo is the ~40s-per-product stall that broke large runs)
        // or when it must not be trusted: TOV codes only ever resolve against
        // the TOV catalog (generic web hits mislabeled them), and COMBO codes
        // are Mathis-internal bundles that exist in no catalog anywhere.
        //
        // Other catalog vendors DO get this guarded web fallback when their
        // catalog missed: Vickerman drops discontinued families from
        // vickerman.com entirely ("VICK-H1PLR000" — the 36" Ivory Plume Reed
        // Bundle — resolves on Google but on no configured catalog), and
        // hitsReferenceSku below keeps loose brand-only matches out.
        if (!WEB_SEARCH_AVAILABLE || isTovLikeSku(sku) || /COMBO/i.test(sku)) {
          // The catalog didn't have this exact SKU (discontinued / unpublished), so we have
          // no title — but the SKU structure may still tell us the product family. Attach it
          // as a category hint so the AI categorizes the family instead of flagging "No match".
          const hint = skuCategoryHint(sku);
          results[idx] = hint
            ? { ...p, vendorCategory: p.vendorCategory ?? hint, vendorContext: [p.vendorContext, `sku_type_hint: ${hint}`].filter(Boolean).join("; ") }
            : p;
          return;
        }

        const variants = skuSearchVariants(sku);
        let hits: SearchHit[] = [];
        let usedQuery = variants[0] ?? sku;

        for (const v of variants) {
          hits = await searchWeb(v, sku);
          usedQuery = v;
          if (hits.length > 0) {
            const digits = (v.match(/\d{4,}/) ?? [])[0];
            if (!digits || hits.some((h) => `${h.title} ${h.snippet}`.includes(digits))) break;
          }
        }

        if (!hits.length) {
          const hint = skuCategoryHint(sku);
          results[idx] = hint
            ? { ...p, vendorCategory: p.vendorCategory ?? hint, vendorContext: [p.vendorContext, `sku_type_hint: ${hint}`].filter(Boolean).join("; ") }
            : p;
          return;
        }

        const resolvedName = pickProductName(hits, usedQuery);
        if (!resolvedName) {
          results[idx] = p;
          return;
        }

        // BULLETPROOF GUARD: only trust a web-resolved name if the search results actually
        // reference this SKU (or one of its variants — retailer pages carry the vendor's own
        // form of the code, without our sheet prefix). Otherwise it's a loose brand/keyword
        // match (the "TOV → TOTO toilet" failure) and we leave the row unresolved so it goes
        // to review instead of being confidently mislabeled.
        const blob = hits.map((h) => `${h.title} ${h.snippet}`).join(" ");
        if (!hitsReferenceSku(blob, sku, variants)) {
          results[idx] = p;
          return;
        }

        const brand = p.brand || guessBrand(hits, resolvedName);
        const searchContext = hits
          .slice(0, 3)
          .map((h) => [h.title, h.snippet].filter(Boolean).join(": "))
          .join(" | ");
        const description =
          p.description ||
          hits.find((h) => h.snippet.length > 40)?.snippet.slice(0, 200) ||
          null;

        const enrichment: SkuEnrichment = {
          productId: p.id,
          name: resolvedName,
          brand,
          description,
          searchContext,
        };
        enrichments.push(enrichment);

        results[idx] = {
          ...p,
          name: resolvedName,
          brand,
          description,
          vendorContext: [p.vendorContext, `resolved_from_sku: ${sku}`, `web: ${searchContext.slice(0, 280)}`]
            .filter(Boolean)
            .join("; "),
        };
      }),
    );
    done += slice.length;
    onProgress?.(Math.min(done, products.length), products.length);
  }

  for (let i = 0; i < results.length; i++) out.push(results[i] ?? products[i]!);
  return { products: out, enrichments };
}
