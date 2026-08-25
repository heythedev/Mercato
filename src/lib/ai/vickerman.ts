import type { CatalogEntry } from "./vendor-catalog";
import { getProducts, keywordSearch } from "@/lib/keepa/client";
import { normalizeMany } from "@/lib/keepa/product";

/**
 * Vickerman catalog resolver (vickerman.com — ASP.NET storefront, NOT Shopify).
 *
 * Mathis "VICK-…" sheets are bare vendor codes: no title, no description, no category.
 * vickerman.com has no /products.json, so the Shopify vendor-catalog path can't ingest
 * it. What it DOES have:
 *
 *   1. /sitemap.xml — ~4k product URLs of the form /p/<title-slug>-<familycode>
 *      ("/p/vickerman-green-artificial-fittonia-bush-ftl2501"). The slug tail is the
 *      product FAMILY code; sheet codes are usually that family plus a size/color
 *      suffix (FTL250133UV → family FTL2501), so exact-tail + longest-prefix matching
 *      resolves most codes offline from one cached fetch. Sheet codes with NUMERIC
 *      suffixes (TN1703014) never prefix-match slug tails carrying LETTER color
 *      suffixes (TN1702EG) — the family-ROOT index below bridges that by stripping
 *      the tail's trailing letter run and accepting a 1–4 digit remainder.
 *   2. /search?q=<code> — server-rendered HTML whose result links are /p/ pages.
 *      Kept as a last-ditch on-site path, but the endpoint currently returns no
 *      /p/ hits even for codes with live pages — hence the sitemap fetch retries
 *      and the Amazon fallback below.
 *   3. /p/<slug> pages carry a <dt>/<dd> spec list (Product Type, Primary Material,
 *      Weight, Dimensions, UPC), feature bullets, and per-variant images named
 *      /images/<EXACTCODE>_1000.jpg — real data for categorization AND for the export
 *      template's attribute columns.
 *
 * Codes vickerman.com doesn't carry at all are looked up on Amazon via Keepa —
 * accepted ONLY when the listing is Vickerman-branded AND its model/part number is
 * consistent with our code. "COMBO…" codes are Mathis-internal bundles that exist in
 * no catalog and are never searched.
 *
 * A code that can't be matched consistently stays unresolved on purpose — the
 * categorize gate then routes it to review instead of letting the model guess from
 * the raw code (the "455 products bulk-stamped Christmas at 0.9" failure).
 */

const SITE = "https://vickerman.com";
const BROWSER_UA = "Mozilla/5.0";
const SITEMAP_TTL_MS = 24 * 60 * 60 * 1000;
/** Minimum shared prefix for a family match — short overlaps match across families. */
const MIN_FAMILY_LEN = 6;

export function isVickermanSku(sku: string): boolean {
  return /^VICK([-_ ]|$)/i.test(sku.trim());
}

/** Sheet code → Vickerman's own catalog code: strip the VICK- prefix, keep alphanumerics. */
function vickCode(sku: string): string {
  return sku
    .trim()
    .toUpperCase()
    .replace(/^VICK[-_ ]*/, "")
    .replace(/[^A-Z0-9.]/g, "");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url: string, timeoutMs = 15000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── Sitemap index ─────────────────────────────────────────────────────────────

type SitemapIndex = {
  /** UPPERCASE slug-tail code → full /p/ slug. */
  bySlugTail: Map<string, string>;
  /** All tail codes, for longest-prefix family matching. */
  tails: string[];
  /**
   * Family root (tail minus its trailing letter run, e.g. A1183G → A1183) → slug.
   * Sheet codes append a numeric size suffix to the family root (A1183026), while
   * site tails append a letter color suffix — so plain prefix matching can never
   * connect them; this index can.
   */
  roots: Map<string, string>;
};

let sitemapCache: { index: SitemapIndex; fetchedAt: number } | null = null;
let sitemapInflight: Promise<SitemapIndex | null> | null = null;

function slugTail(slug: string): string {
  const m = slug.match(/-([a-z0-9.]+)$/i);
  return (m?.[1] ?? "").toUpperCase();
}

async function getSitemapIndex(): Promise<SitemapIndex | null> {
  if (sitemapCache && Date.now() - sitemapCache.fetchedAt < SITEMAP_TTL_MS) {
    return sitemapCache.index;
  }
  if (sitemapInflight) return sitemapInflight;

  sitemapInflight = (async () => {
    try {
      // Retry once: the sitemap is the resolver's backbone (site search is dead),
      // so a transient fetch failure must not silently zero out a whole run.
      const xml =
        (await fetchText(`${SITE}/sitemap.xml`, 30000)) ??
        (await fetchText(`${SITE}/sitemap.xml`, 45000));
      if (!xml) return sitemapCache?.index ?? null;
      const bySlugTail = new Map<string, string>();
      for (const m of xml.matchAll(/<loc>[^<]*\/p\/([^<]+)<\/loc>/g)) {
        const slug = m[1]!.trim();
        const tail = slugTail(slug);
        if (tail) bySlugTail.set(tail, slug);
      }
      if (bySlugTail.size === 0) return sitemapCache?.index ?? null;

      // Family-root index: strip each tail's trailing letter run (the color code).
      // Roots must keep a digit and ≥5 chars or they'd match across families.
      // When several tails share a root, prefer the tail that IS the root (the
      // family's base page), else the shortest tail (most generic variant).
      const roots = new Map<string, string>();
      const rootTail = new Map<string, string>();
      for (const [tail, slug] of bySlugTail) {
        const root = tail.replace(/[A-Z]+$/, "");
        if (root.length < 5 || !/\d/.test(root)) continue;
        const prev = rootTail.get(root);
        if (!prev || (prev !== root && (tail === root || tail.length < prev.length))) {
          rootTail.set(root, tail);
          roots.set(root, slug);
        }
      }

      const index: SitemapIndex = { bySlugTail, tails: [...bySlugTail.keys()], roots };
      sitemapCache = { index, fetchedAt: Date.now() };
      return index;
    } finally {
      sitemapInflight = null;
    }
  })();
  return sitemapInflight;
}

/** True when one code is a prefix of the other with enough shared length to mean "same family". */
function familyConsistent(a: string, b: string): boolean {
  if (!a || !b) return false;
  const shorter = Math.min(a.length, b.length);
  if (shorter < MIN_FAMILY_LEN) return false;
  return a.startsWith(b) || b.startsWith(a);
}

/** Longest sitemap tail that is prefix-consistent with the code (the family root page). */
function familyMatch(index: SitemapIndex, code: string): string | null {
  let best: string | null = null;
  let bestLen = 0;
  for (const tail of index.tails) {
    if (tail.length <= bestLen) continue;
    if (familyConsistent(code, tail)) {
      best = index.bySlugTail.get(tail)!;
      bestLen = tail.length;
    }
  }
  return best;
}

/**
 * Longest family root R with code = R + numeric size suffix (1–4 digits).
 * Catches sheet codes whose digits diverge from every tail's letter color suffix
 * (A1183026 vs site pages A1183G/A1183SW), which familyMatch can never connect.
 */
function rootMatch(index: SitemapIndex, code: string): string | null {
  let best: string | null = null;
  let bestLen = 0;
  for (const [root, slug] of index.roots) {
    if (root.length <= bestLen || !code.startsWith(root)) continue;
    const rem = code.slice(root.length);
    if (rem.length >= 1 && rem.length <= 4 && /^\d+$/.test(rem)) {
      best = slug;
      bestLen = root.length;
    }
  }
  return best;
}

// ── Site search fallback ──────────────────────────────────────────────────────

async function searchSite(code: string): Promise<string | null> {
  // Second attempt trims the trailing size/color suffix; the guard below still
  // requires every hit to be prefix-consistent with the FULL code, so a trimmed
  // query can surface the family page but never smuggle in a wrong product.
  const queries = [code];
  if (code.length > 8) queries.push(code.slice(0, code.length - 2));

  for (const q of queries) {
    const html = await fetchText(`${SITE}/search?q=${encodeURIComponent(q)}`, 12000);
    if (!html) continue;
    const seen = new Set<string>();
    for (const m of html.matchAll(/href="\/p\/([^"?#]+)/gi)) {
      const slug = m[1]!;
      if (seen.has(slug)) continue;
      seen.add(slug);
      if (familyConsistent(code, slugTail(slug))) return slug;
    }
  }
  return null;
}

// ── Product page (PDP) parsing ────────────────────────────────────────────────

type VickPdp = {
  title: string;
  /** dt/dd spec pairs, e.g. { "Product Type": "Everyday Greenery", "Primary Material": "EVA" }. */
  specs: Record<string, string>;
  /** Feature bullet text, joined — the only prose description the page carries. */
  description: string | null;
  /** Image URLs grouped by the exact variant code embedded in the filename. */
  imagesByCode: Map<string, string[]>;
};

const pdpCache = new Map<string, VickPdp | null>();

async function fetchPdp(slug: string): Promise<VickPdp | null> {
  if (pdpCache.has(slug)) return pdpCache.get(slug)!;

  let pdp: VickPdp | null = null;
  const html = await fetchText(`${SITE}/p/${slug}`, 12000);
  if (html) {
    const title =
      decodeEntities(html.match(/<title>([^<|]+)/)?.[1] ?? "") ||
      decodeEntities((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? "").replace(/<[^>]+>/g, " "));

    const specs: Record<string, string> = {};
    for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/g)) {
      const k = decodeEntities(m[1]!.replace(/<[^>]+>/g, " "));
      const v = decodeEntities(m[2]!.replace(/<[^>]+>/g, " "));
      if (k && v && k.length <= 60 && v.length <= 200) specs[k] = v;
    }

    // Feature bullets are plain-text <li>s; navigation <li>s contain anchors — skip those.
    const bullets: string[] = [];
    for (const m of html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)) {
      if (/<a[\s>]/i.test(m[1]!)) continue;
      const text = decodeEntities(m[1]!.replace(/<[^>]+>/g, " "));
      if (text.length >= 30 && text.length <= 300) bullets.push(text);
      if (bullets.length >= 4) break;
    }

    const imagesByCode = new Map<string, string[]>();
    for (const m of html.matchAll(/\/images\/([A-Z0-9.]+)_(?:1000|200|100)(?:_[A-Z0-9]+)?\.jpg/gi)) {
      const code = m[1]!.toUpperCase();
      const url = `${SITE}/images/${m[1]}_1000.jpg`;
      const list = imagesByCode.get(code) ?? [];
      if (!list.includes(url)) {
        list.push(url);
        imagesByCode.set(code, list);
      }
    }

    if (title) {
      pdp = { title, specs, description: bullets.length ? bullets.join(" ") : null, imagesByCode };
    }
  }

  pdpCache.set(slug, pdp);
  return pdp;
}

/** "13" × 10" × 29"" (L × W × H) → the Mathis template's three dimension columns. */
function dimensionAttributes(dims: string): Record<string, string> {
  const parts = dims.split(/[×x]/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 3) return {};
  return {
    "Depth Dimension (Front to Back)": parts[0]!,
    "Width Dimension (Left to Right)": parts[1]!,
    "Height Dimension (Bottom to Top)": parts[2]!,
  };
}

// ── Amazon fallback (Keepa) ───────────────────────────────────────────────────

const amazonCache = new Map<string, CatalogEntry | null>();

/**
 * Codes vickerman.com no longer lists (discontinued families) are often still sold
 * by Vickerman on Amazon with the catalog code as the listing's model/part number.
 * Double-guarded so this can enrich but never mislabel: the listing must be
 * Vickerman-branded AND its model/part number (or title) must be consistent with
 * our code. "COMBO…" codes are Mathis-built bundles that exist in no catalog —
 * never searched, they stay unresolved for review.
 */
async function amazonFallback(code: string): Promise<CatalogEntry | null> {
  if (!process.env.KEEPA_API_KEY) return null;
  if (/^COMBO/i.test(code)) return null;
  if (amazonCache.has(code)) return amazonCache.get(code)!;

  let entry: CatalogEntry | null = null;
  try {
    const { asinList } = await keywordSearch(1, `Vickerman ${code}`);
    if (asinList.length) {
      const raw = await getProducts(1, asinList.slice(0, 10));
      const norm = (s: unknown) =>
        String(s ?? "")
          .toUpperCase()
          .replace(/[^A-Z0-9.]/g, "");
      for (const c of normalizeMany(raw, 1)) {
        if (!c.title) continue;
        if (!/vickerman/i.test(`${c.brand ?? ""} ${c.title}`)) continue;
        const ids = [c.model, c.partNumber].map(norm).filter((s) => s.length >= 5);
        const codeConsistent =
          ids.some((id) => id === code || code.startsWith(id) || id.startsWith(code)) ||
          norm(c.title).includes(code);
        if (!codeConsistent) continue;
        const options: Record<string, string> = {};
        if (c.upc) options["UPC"] = String(c.upc);
        entry = {
          sku: code,
          title: c.title.trim(),
          brand: "Vickerman",
          description: c.description ?? null,
          image: c.image ?? c.images[0] ?? null,
          handle: `amazon:${c.asin}`,
          tags: c.category ? [c.category] : [],
          category: c.category ?? null,
          images: c.images,
          options,
          grams: typeof c.weightG === "number" && c.weightG > 0 ? Math.round(c.weightG) : null,
        };
        break;
      }
    }
  } catch {
    // Keepa outage/quota — leave unresolved rather than caching a hard failure state.
    return null;
  }

  amazonCache.set(code, entry);
  return entry;
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Resolve a "VICK-…" sheet code to a CatalogEntry via vickerman.com, falling back
 * to a strictly-validated Amazon listing via Keepa when the site has no match.
 * Returns null when no family-consistent product can be found — never a loose guess.
 */
export async function resolveVickermanSku(sku: string): Promise<CatalogEntry | null> {
  const code = vickCode(sku);
  if (code.length < 4) return null;

  const index = await getSitemapIndex();
  let slug = index?.bySlugTail.get(code) ?? null;
  const exact = !!slug;
  if (!slug && index) slug = familyMatch(index, code);
  if (!slug && index) slug = rootMatch(index, code);
  if (!slug) slug = await searchSite(code);
  if (!slug) return amazonFallback(code);

  const pdp = await fetchPdp(slug);
  if (!pdp) return amazonFallback(code);

  // Prefer the images whose filename carries OUR exact code (each size/color variant
  // has its own photos); fall back to the family page's images.
  const ownImages = pdp.imagesByCode.get(code) ?? [];
  const images = ownImages.length
    ? ownImages
    : [...pdp.imagesByCode.values()].flat().slice(0, 10);

  // Spec values feed the export template's attribute columns via catalogEntryToAttributes
  // (options are copied into vendorData verbatim, normalize-matched to template headers).
  // Physical specs describe ONE variant, so they are only trusted on an exact-code match
  // (or when our images matched, which proves the page covers our variant).
  const options: Record<string, string> = {};
  const material = pdp.specs["Primary Material"] ?? pdp.specs["Material"];
  if (material) options["Material"] = material;
  let grams: number | null = null;
  if (exact || ownImages.length > 0) {
    if (pdp.specs["UPC"]) options["UPC"] = pdp.specs["UPC"];
    const dims = Object.entries(pdp.specs).find(([k]) => /^Dimensions/i.test(k))?.[1];
    if (dims) Object.assign(options, dimensionAttributes(dims));
    const lb = parseFloat((pdp.specs["Weight"] ?? "").replace(/[^\d.]/g, ""));
    if (Number.isFinite(lb) && lb > 0) grams = Math.round(lb * 453.592);
  }

  const productType = pdp.specs["Product Type"]?.trim() || null;

  return {
    sku: code,
    title: pdp.title,
    brand: "Vickerman",
    description: pdp.description,
    image: images[0] ?? null,
    handle: slug,
    // The vendor's own classification ("Everyday Greenery", "Christmas Trees", …) —
    // the anchor the categorizer needs so a bare code stops reading as "Christmas".
    tags: productType ? [productType] : [],
    category: productType,
    images,
    options,
    grams,
  };
}
