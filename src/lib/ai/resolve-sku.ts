import { resolveSkuFromCatalog, hasCatalogVendor } from "./vendor-catalog";

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

export type SkuEnrichment = {
  productId: string;
  name: string;
  brand: string | null;
  description: string | null;
  searchContext: string;
};

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

async function searchSerpApi(query: string): Promise<SearchHit[]> {
  const key = process.env.SERPAPI_KEY;
  if (!key) return [];
  try {
    const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&engine=google&api_key=${key}&num=5`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
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

function pickProductName(hits: SearchHit[], sku: string): string | null {
  const skuNorm = sku.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const hit of hits) {
    // Prefer titles that look like real product names (have spaces / words)
    const title = hit.title.split("|")[0]?.trim() ?? hit.title;
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
  return hits[0]?.title.split("|")[0]?.trim() || null;
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
          const enrichment: SkuEnrichment = {
            productId: p.id,
            name: catalogEntry.title,
            brand: catalogEntry.brand || p.brand,
            description: catalogEntry.description || p.description,
            searchContext: `catalog: ${catalogEntry.sku} | ${catalogEntry.title}`,
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

        // Skip web search when it can't produce anything: a TOV-style code already tried
        // its own catalog above (and we don't trust generic web results for it), and any
        // other code has no working provider unless SerpAPI is configured. Pursuing a
        // dead DuckDuckGo here is the ~40s-per-product stall that broke large runs.
        if (!WEB_SEARCH_AVAILABLE || hasCatalogVendor(sku)) {
          results[idx] = p;
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
          results[idx] = p;
          return;
        }

        const resolvedName = pickProductName(hits, usedQuery);
        if (!resolvedName) {
          results[idx] = p;
          return;
        }

        // BULLETPROOF GUARD: only trust a web-resolved name if the search results actually
        // reference this SKU. We require the SKU's distinctive digit core to appear as a
        // *bounded* number in a hit (not merely a substring of a longer number) — otherwise
        // it's a loose brand/keyword match (the "TOV → TOTO toilet" failure) and we leave the
        // row unresolved so it goes to review instead of being confidently mislabeled.
        const blob = hits.map((h) => `${h.title} ${h.snippet}`).join(" ");
        const skuCore = (sku.match(/\d{4,}/g) ?? []).pop();
        const isDegenerate = !!skuCore && /^(\d)\1+$/.test(skuCore); // e.g. "0000", "11111"
        const hitDigitTokens = new Set(blob.match(/\d+/g) ?? []);
        const normSku = sku.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const normBlob = blob.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const referencesSku =
          (!!skuCore && !isDegenerate && hitDigitTokens.has(skuCore)) ||
          (normSku.length >= 6 && normBlob.includes(normSku));
        if (!referencesSku) {
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
