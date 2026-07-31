/**
 * Vendor catalog index (Shopify `/products.json`).
 *
 * SKU-only vendor sheets (common for Mathis furniture uploads) give us nothing but the
 * vendor's own product code, e.g. "TOVF-TOVT54304FBMP". That code is authoritative — it
 * lives in the vendor's own catalog. Rather than guessing search variants and scraping the
 * storefront search page per row, we download the vendor's full catalog once, build a
 * SKU index, and match against it exactly.
 *
 * Matching strategy (most reliable first):
 *   1. Exact normalized SKU      — "TOV-T54304" == sheet code after stripping punctuation
 *   2. Catalog SKU as substring  — sheet "TOVF-TOVT54304FBMP" contains catalog "TOVT54304"
 *   3. Digit-core + series letter — "54304" preceded by "T"; unique digit cores resolve cleanly
 *
 * The index is cached in-memory and refreshed daily.
 */

export type CatalogEntry = {
  sku: string;
  title: string;
  brand: string | null;
  description: string | null;
  image: string | null;
  handle: string;
  /** Cleaned, human-meaningful category tags from the vendor (e.g. ["Decor","Placemats","Tabletop"]). */
  tags: string[];
  /**
   * The vendor's OWN canonical category path from the product page breadcrumb
   * (e.g. "Bedroom Furniture", "Decor"). This is the single primary category the vendor
   * files the product under — more precise than the multi-room tags. Populated lazily.
   */
  category: string | null;
  /** All product image URLs (many marketplaces want several image columns filled). */
  images: string[];
  /**
   * Per-variant attributes keyed by the Shopify option name (e.g. { Size: "8x10",
   * Color: "Moroccan Blue and Ivory" }). Vendor sheets that are bare SKUs carry none of
   * this, so it's the only source for the template's Size/Color/… attribute columns.
   */
  options: Record<string, string>;
  /** Variant weight in grams, when the catalog provides it (→ Product Weight column). */
  grams: number | null;
};

type IndexedEntry = { series: string; normSku: string; entry: CatalogEntry };

type CatalogIndex = {
  bySku: Map<string, CatalogEntry>;
  byCore: Map<string, IndexedEntry[]>;
  size: number;
};

type ShopifyProduct = {
  title?: string;
  handle?: string;
  vendor?: string;
  body_html?: string;
  images?: { src?: string }[];
  variants?: {
    sku?: string;
    option1?: string | null;
    option2?: string | null;
    option3?: string | null;
    grams?: number | null;
  }[];
  options?: { name?: string; position?: number }[];
  tags?: string[] | string;
  /** Shopify's own product classification, e.g. Modway's "\\Living\\Sofas". */
  product_type?: string;
};

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // refresh daily
const MAX_PAGES = 50; // safety cap (~12.5k products at 250/page)
const BROWSER_UA = "Mozilla/5.0";

const cache = new Map<string, { index: CatalogIndex; fetchedAt: number }>();
const inflight = new Map<string, Promise<CatalogIndex>>();
// Canonical category per product page (keyed "domain/handle"), cached across lookups.
const categoryCache = new Map<string, string | null>();

/** Uppercase and strip all punctuation so "TOV-T54304" and "TOVT54304" compare equal. */
function normalizeSku(sku: string): string {
  return sku.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** The last run of 4+ digits — the distinctive numeric core of a vendor code. */
function digitCore(normSku: string): string | null {
  const matches = normSku.match(/\d{4,}/g);
  return matches?.length ? matches[matches.length - 1]! : null;
}

/** The alphabetic char immediately before the digit core (e.g. the "T" in "TOVT54304"). */
function seriesLetter(normSku: string, core: string): string {
  const idx = normSku.lastIndexOf(core);
  if (idx <= 0) return "";
  const prev = normSku[idx - 1] ?? "";
  return /[A-Z]/.test(prev) ? prev : "";
}

// Operational / logistics tags that carry no category meaning. Everything matching these
// is dropped so only real category signals (Decor, Placemats, Tabletop, Furniture…) remain.
const NOISE_TAG_RE = /flow|processed|ready[-\s]?to[-\s]?ship|\baov\b|shipping|swatch|matrix|ygroup|clearance|sale|new\b|bestsell|price|instock|in[-\s]?stock|preorder|discontinu/i;

/** Keep only human-meaningful, Title-Case-ish category tags; drop operational noise. */
function cleanTags(raw: string[] | string | undefined): string[] {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of arr) {
    const tag = t.trim();
    if (!tag || tag.length < 2 || tag.length > 40) continue;
    if (/[_]/.test(tag)) continue; // codes like YGroup_Peele-Placemat
    if (/\d/.test(tag)) continue; // tags with digits are usually operational
    if (NOISE_TAG_RE.test(tag)) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
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

async function fetchAllProducts(domain: string): Promise<ShopifyProduct[]> {
  const all: ShopifyProduct[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `https://${domain}/products.json?limit=250&page=${page}`;
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) break;
    const data = (await res.json()) as { products?: ShopifyProduct[] };
    const products = data.products ?? [];
    if (products.length === 0) break;
    all.push(...products);
    if (products.length < 250) break; // last page
  }
  return all;
}

function buildIndex(products: ShopifyProduct[]): CatalogIndex {
  const bySku = new Map<string, CatalogEntry>();
  const byCore = new Map<string, IndexedEntry[]>();

  for (const p of products) {
    const title = (p.title ?? "").trim();
    if (!title) continue;
    const brand = (p.vendor ?? "").trim() || null;
    const description = p.body_html ? stripHtml(p.body_html).slice(0, 300) || null : null;
    const image = (p.images ?? []).find((i) => i.src)?.src ?? null;
    const images = (p.images ?? []).map((i) => i.src).filter((s): s is string => !!s);
    const tags = cleanTags(p.tags);
    const handle = (p.handle ?? "").trim();
    // Prefer Shopify's product_type as the category — it's in products.json already, so
    // no per-product page fetch is needed. "\\Living\\Sofas" → "Living > Sofas".
    const productTypeCategory = (p.product_type ?? "")
      .split(/[\\/]+/).map((s) => s.trim()).filter(Boolean).join(" > ") || null;
    // Option names (Size, Color, …) map positionally to each variant's option1/2/3.
    const optionNames = (p.options ?? [])
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((o) => (o.name ?? "").trim());

    for (const v of p.variants ?? []) {
      const sku = (v.sku ?? "").trim();
      if (!sku) continue;
      // Pair each option value with its name: { Size: "8x10", Color: "Blue and Ivory" }.
      const options: Record<string, string> = {};
      [v.option1, v.option2, v.option3].forEach((val, i) => {
        const name = optionNames[i];
        const value = (val ?? "").trim();
        if (name && value && value.toLowerCase() !== "default title") options[name] = value;
      });
      const entry: CatalogEntry = {
        sku, title, brand, description, image, handle, tags, category: productTypeCategory,
        images, options, grams: typeof v.grams === "number" && v.grams > 0 ? v.grams : null,
      };
      const normSku = normalizeSku(sku);
      if (normSku && !bySku.has(normSku)) bySku.set(normSku, entry);

      const core = digitCore(normSku);
      if (core) {
        const series = seriesLetter(normSku, core);
        const list = byCore.get(core) ?? [];
        list.push({ series, normSku, entry });
        byCore.set(core, list);
      }
    }
  }

  return { bySku, byCore, size: bySku.size };
}

async function getIndex(domain: string): Promise<CatalogIndex> {
  const cached = cache.get(domain);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.index;

  const existing = inflight.get(domain);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const products = await fetchAllProducts(domain);
      const index = buildIndex(products);
      // Only replace the cache if we actually got a usable catalog; otherwise keep stale data.
      if (index.size > 0) cache.set(domain, { index, fetchedAt: Date.now() });
      return cache.get(domain)?.index ?? index;
    } finally {
      inflight.delete(domain);
    }
  })();

  inflight.set(domain, promise);
  return promise;
}

/** Look up a single (possibly messy) vendor SKU against a prebuilt catalog index. */
function matchInIndex(index: CatalogIndex, rawSku: string): CatalogEntry | null {
  const norm = normalizeSku(rawSku);
  if (!norm) return null;

  // 1. Exact normalized match
  const exact = index.bySku.get(norm);
  if (exact) return exact;

  // 2. Digit-core (+ series letter) match
  const core = digitCore(norm);
  if (!core) return null;
  const candidates = index.byCore.get(core);
  if (!candidates?.length) return null;

  // 2a. Prefer a candidate whose full normalized SKU is contained in the sheet code
  //     (e.g. sheet "TOVFTOVT54304FBMP" contains catalog "TOVT54304").
  const substring = candidates.filter((c) => norm.includes(c.normSku));
  if (substring.length === 1) return substring[0]!.entry;

  if (candidates.length === 1) return candidates[0]!.entry;

  // 2b. Multiple products share this digit core → disambiguate by series letter.
  const series = seriesLetter(norm, core);
  if (series) {
    const bySeries = candidates.filter((c) => c.series === series);
    if (bySeries.length === 1) return bySeries[0]!.entry;

    // 2c. Same title across all series matches → it's ONE product sold in several
    //     color/size variants (Modway rugs: "R-1091A-58", "R-1091D-810" are all the
    //     "Minu …" rug). The sheet code may name a variant that isn't individually
    //     listed (a size the catalog doesn't carry), so exact-SKU match fails — but the
    //     title (all we need for categorization) is unambiguous. Return it.
    if (bySeries.length > 1) {
      const titles = new Set(bySeries.map((c) => c.entry.title));
      if (titles.size === 1) return bySeries[0]!.entry;
    }
  }

  // Last resort: every candidate for this digit core is the same product regardless of
  // series letter — still an unambiguous title, so it's safe to categorize from.
  const allTitles = new Set(candidates.map((c) => c.entry.title));
  if (allTitles.size === 1) return candidates[0]!.entry;

  // Ambiguous — refuse to guess rather than risk a mislabel.
  return null;
}

// ── Vendor registry ───────────────────────────────────────────────────────────
// Each vendor maps a SKU pattern to its Shopify catalog domain. Add new Shopify
// vendors here — no other code changes needed.

type Vendor = { name: string; domain: string; matches: (sku: string) => boolean };

const VENDORS: Vendor[] = [
  { name: "TOV Furniture", domain: "tovfurniture.com", matches: (sku) => /\btov/i.test(sku) },
  // Modway sheets use codes like "MODA-EEI1011BEI" / "MOD-7355-TAU"; their Shopify
  // catalog (modway.com) files each product under a real product_type ("\Living\Sofas").
  { name: "Modway", domain: "modway.com", matches: (sku) => /\b(moda|modway|eei-?\d|mod-?\d)/i.test(sku) },
];

/**
 * Fetch the vendor's canonical category for a product from its page's structured-data
 * breadcrumb (JSON-LD BreadcrumbList) — e.g. "Bedroom Furniture" or "Decor". This is the
 * single primary category the vendor files the product under, which resolves the ambiguity
 * of products tagged with multiple rooms. Cached per handle.
 */
async function fetchCanonicalCategory(domain: string, handle: string): Promise<string | null> {
  if (!handle) return null;
  const key = `${domain}/${handle}`;
  if (categoryCache.has(key)) return categoryCache.get(key)!;

  let category: string | null = null;
  try {
    const res = await fetch(`https://${domain}/products/${handle}`, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const html = await res.text();
      for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
        let data: unknown;
        try {
          data = JSON.parse(m[1]!);
        } catch {
          continue;
        }
        if (data && typeof data === "object" && (data as { "@type"?: string })["@type"] === "BreadcrumbList") {
          const items = (data as { itemListElement?: { name?: string; item?: { name?: string } }[] }).itemListElement ?? [];
          const names = items
            .map((it) => (it.name ?? it.item?.name ?? "").trim())
            .filter(Boolean);
          // Drop the leading "Home" and the trailing product title → the category path in between.
          const middle = names.slice(1, -1).filter((n) => !/^home$/i.test(n));
          if (middle.length) category = middle.join(" > ");
          break;
        }
      }
    }
  } catch {
    /* leave category null */
  }

  categoryCache.set(key, category);
  return category;
}

/**
 * Resolve a SKU-only product to a real catalog entry via the vendor's Shopify catalog.
 * Returns null if no vendor matches, the catalog is unreachable, or the match is ambiguous.
 * When a match is found, also enriches it with the vendor's canonical breadcrumb category.
 */
export async function resolveSkuFromCatalog(sku: string): Promise<CatalogEntry | null> {
  const vendor = VENDORS.find((v) => v.matches(sku));
  if (!vendor) return null;
  try {
    const index = await getIndex(vendor.domain);
    const match = matchInIndex(index, sku);
    if (!match) return null;
    // If the catalog already gave us a category (Shopify product_type), use it — no need
    // for the extra per-product breadcrumb page fetch, which is what makes bulk runs slow.
    if (match.category) return match;
    const category = await fetchCanonicalCategory(vendor.domain, match.handle);
    return category ? { ...match, category } : match;
  } catch {
    return null;
  }
}

/** True when some registered vendor recognizes this SKU (so the caller can skip generic web search). */
export function hasCatalogVendor(sku: string): boolean {
  return VENDORS.some((v) => v.matches(sku));
}
