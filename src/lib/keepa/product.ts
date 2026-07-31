import type { KeepaProduct, NormalizedProduct } from "./types";
import { getMarketplace } from "./domains";

const IMG_BASE = "https://m.media-amazon.com/images/I/";

// Keepa csv / stats.current indices we use.
const IDX = {
  AMAZON: 0,
  NEW: 1,
  USED: 2,
  SALES: 3,
  LIST_PRICE: 4, // manufacturer list price / MSRP
  NEW_FBA: 10,
  COUNT_NEW: 11,
  RATING: 16,
  REVIEW_COUNT: 17,
  BUY_BOX: 18,
} as const;

/** Keepa attribute value: positive number, else null (Keepa uses -1/0 for unknown). */
function pos(v: unknown): number | null {
  return typeof v === "number" && v > 0 ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** First usable barcode from a Keepa code list, coerced to string (Keepa may
 *  return numeric EAN/UPC values) and validated as an 8–14 digit code. */
function firstBarcode(list?: (string | number)[] | null): string | null {
  for (const c of list ?? []) {
    const s = String(c).trim();
    if (/^\d{8,14}$/.test(s)) return s;
  }
  return null;
}

function lastValue(csv?: number[] | null): number | null {
  if (!csv || csv.length < 2) return null;
  const v = csv[csv.length - 1];
  return typeof v === "number" && v >= 0 ? v : null;
}

/** Prefer the precomputed stat; fall back to the latest point in the csv history. */
function statOrCsv(p: KeepaProduct, index: number): number | null {
  const s = p.stats?.current?.[index];
  if (typeof s === "number" && s >= 0) return s;
  return lastValue(p.csv?.[index] ?? null);
}

// Offer types worth treating as a "price", best first.
const PRICE_IDXS = [IDX.BUY_BOX, IDX.AMAZON, IDX.NEW, IDX.NEW_FBA, IDX.USED] as const;

function fromAvg(avg: number[] | undefined): number | null {
  if (!avg) return null;
  for (const idx of PRICE_IDXS) {
    const v = avg[idx];
    if (typeof v === "number" && v > 0) return v;
  }
  return null;
}

// Offer types that count toward "is it buyable" for a dropshipper; best availability wins.
const OOS_IDXS = [IDX.NEW, IDX.BUY_BOX, IDX.AMAZON, IDX.NEW_FBA] as const;

/**
 * 90-day out-of-stock %: the BEST (lowest) OOS across the offer types a dropshipper
 * could source from. If Keepa has no OOS data for any of them, the listing has had
 * no buyable offer in 90 days → treat as 100% out of stock.
 */
export function pickOos(p: KeepaProduct): number | null {
  const arr = p.stats?.outOfStockPercentage90;
  if (!Array.isArray(arr)) return null;
  let best: number | null = null;
  for (const idx of OOS_IDXS) {
    const v = arr[idx];
    if (typeof v === "number" && v >= 0) best = best == null ? v : Math.min(best, v);
  }
  return best == null ? 100 : best;
}

export function pickPrice(p: KeepaProduct): number | null {
  // 1) A current live offer.
  for (const idx of PRICE_IDXS) {
    const v = statOrCsv(p, idx);
    if (v != null && v > 0) return v;
  }
  // 2) Recent averages — covers items currently out of stock / no live offer.
  // Widen to the full requested stats window (`avg`, e.g. 180-day) so a product
  // that last sold 90–180 days ago still yields a price instead of dropping out.
  const avg =
    fromAvg(p.stats?.avg30) ?? fromAvg(p.stats?.avg90) ?? fromAvg(p.stats?.avg);
  if (avg != null) return avg;
  // 3) Last resort: manufacturer list price (MSRP) if Keepa has it.
  const list = statOrCsv(p, IDX.LIST_PRICE);
  if (list != null && list > 0) return list;
  return null;
}

/** Build large + medium image URL lists, supporting both the new `images` array and legacy `imagesCSV`. */
function buildImages(p: KeepaProduct): { large: string[]; medium: string[] } {
  const large: string[] = [];
  const medium: string[] = [];
  if (Array.isArray(p.images) && p.images.length) {
    for (const img of p.images) {
      const l = img?.l || img?.hiRes || img?.m;
      const m = img?.m || img?.l;
      if (l) large.push(IMG_BASE + l);
      if (m) medium.push(IMG_BASE + m);
    }
  } else if (p.imagesCSV) {
    for (const name of p.imagesCSV.split(",").map((s) => s.trim()).filter(Boolean)) {
      large.push(IMG_BASE + name);
      medium.push(IMG_BASE + name);
    }
  }
  return { large, medium };
}

/**
 * Resolve this product's variation context from Keepa's `variations`/`frozenAttributes`.
 * - theme: the dimension names that vary across the family ("Color, Size").
 * - attributes: THIS item's values keyed by dimension ({Color:"Red", Size:"M"}),
 *   read from its own entry in the family table, falling back to flat color/size.
 * - count: number of children in the family (0 when standalone).
 */
function pickVariation(p: KeepaProduct): {
  theme: string | null;
  attributes: Record<string, string> | null;
  count: number;
} {
  const variations = Array.isArray(p.variations) ? p.variations : [];

  // Theme = the varying dimension names. Prefer Keepa's frozenAttributes; else
  // derive from the union of dimensions seen across the family table.
  let dims = Array.isArray(p.frozenAttributes)
    ? p.frozenAttributes.filter((d): d is string => typeof d === "string" && d.trim().length > 0)
    : [];
  if (!dims.length && variations.length) {
    const seen = new Set<string>();
    for (const v of variations) for (const a of v.attributes ?? []) if (a?.dimension) seen.add(a.dimension);
    dims = [...seen];
  }
  const theme = dims.length ? dims.join(", ") : null;

  // This item's own values, from its row in the family table.
  let attributes: Record<string, string> | null = null;
  const self = variations.find((v) => v.asin === p.asin);
  if (self?.attributes?.length) {
    const m: Record<string, string> = {};
    for (const a of self.attributes) {
      const d = str(a?.dimension);
      const val = str(a?.value);
      if (d && val) m[d] = val;
    }
    if (Object.keys(m).length) attributes = m;
  }
  // Fall back to the flat color/size scalars when the family table omits this child.
  if (!attributes) {
    const flat: Record<string, string> = {};
    const c = str(p.color);
    const s = str(p.size);
    if (c) flat.Color = c;
    if (s) flat.Size = s;
    if (Object.keys(flat).length) attributes = flat;
  }

  return { theme, attributes, count: variations.length };
}

function stripHtml(s?: string | null): string | null {
  if (!s) return null;
  const t = s
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t || null;
}

export function normalizeProduct(p: KeepaProduct, domain: number): NormalizedProduct {
  const mp = getMarketplace(domain);
  const { large, medium } = buildImages(p);

  const category = p.categoryTree?.length
    ? (p.categoryTree[p.categoryTree.length - 1]?.name ?? null)
    : null;

  const description =
    stripHtml(p.description) ?? (p.features?.length ? p.features.join(" • ") : null);

  const host = mp?.host ?? "www.amazon.com";
  const variation = pickVariation(p);

  return {
    asin: p.asin,
    title: p.title ?? p.asin,
    brand: p.brand ?? p.manufacturer ?? null,
    image: large[0] ?? null,
    thumb: medium[0] ?? large[0] ?? null,
    images: large,
    price: pickPrice(p),
    currency: mp?.currency ?? "USD",
    rating: statOrCsv(p, IDX.RATING),
    reviewCount: statOrCsv(p, IDX.REVIEW_COUNT),
    salesRank: statOrCsv(p, IDX.SALES),
    category,
    description,
    features: p.features ?? [],
    amazonUrl: `https://${host}/dp/${p.asin}`,
    domain,
    parentAsin: p.parentAsin ?? null,
    variationTheme: variation.theme,
    variationAttributes: variation.attributes,
    variationCount: variation.count,

    // Sourcing details — prefer package (shipping) values, fall back to item.
    weightG: pos(p.packageWeight) ?? pos(p.itemWeight),
    lengthMm: pos(p.packageLength) ?? pos(p.itemLength),
    widthMm: pos(p.packageWidth) ?? pos(p.itemWidth),
    heightMm: pos(p.packageHeight) ?? pos(p.itemHeight),
    color: str(p.color),
    size: str(p.size),
    model: str(p.model),
    partNumber: str(p.partNumber),
    // Barcode Keepa carries for the listing (UPC preferred, EAN fallback). Amazon
    // lists by ASIN, so this is optional catalog metadata that is legitimately
    // absent for many listings — but when present it lets the verify UPC check
    // actually confirm the match instead of always falling to "could not verify".
    // Coerce to string first: Keepa sometimes returns numeric EAN/UPC codes.
    upc: firstBarcode(p.upcList) ?? firstBarcode(p.eanList),
    packageQuantity: pos(p.packageQuantity) ?? pos(p.numberOfItems),
    offerCount: statOrCsv(p, IDX.COUNT_NEW),
    oosPercent: pickOos(p),
  };
}

export function normalizeMany(products: KeepaProduct[], domain: number): NormalizedProduct[] {
  return products.map((p) => normalizeProduct(p, domain));
}
