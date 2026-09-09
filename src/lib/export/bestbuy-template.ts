import { getCategoryAttributes, miraklConfigured, type MiraklAttribute } from "@/lib/bestbuy/mirakl-client";
import { bestBuyCodeForPath } from "@/lib/ai/bestbuy-taxonomy";

// ── Best Buy per-category templates, generated from Mirakl ───────────────────
// Best Buy's marketplace has 1,450 leaf categories and each one has its OWN
// required attribute set — a downloadable "template" is nothing more than a
// header row of that category's attributes. There is no API that serves the
// template FILE (probed: /api/products/*/template all 404), but PM11 serves the
// attribute configuration those files are generated FROM, so the sheet can be
// rebuilt for any category on demand instead of a human downloading 1,450 of
// them by hand.
//
// Columns are emitted in Mirakl's own attribute order with REQUIRED ones first,
// which is how the portal's own templates present them. Values we hold are
// filled; everything else is left blank for review — deliberately, because a
// guessed value in a required Best Buy attribute fails validation on upload
// and is harder to spot than an empty cell.
//
// Attribute codes are category-scoped ("Car_Amplifiers.productWeight"), so the
// mapping below matches on the LAST dotted segment. That keeps one mapping
// table working across all 1,450 categories instead of per-category rules.

export type BestBuyColumn = {
  /** Verbatim Mirakl attribute code — what the importer keys on. */
  code: string;
  /** Human label, as shown in Best Buy's own template. */
  label: string;
  required: boolean;
  type?: string;
  /** Our product field to fill from, when we have one. */
  fill?: BestBuyFillKey;
};

export type BestBuyFillKey =
  | "categoryName" | "name" | "upc" | "brand" | "description"
  | "imageUrl" | "vendorSku" | "price" | "weight" | "height" | "width" | "depth";

/**
 * Mirakl attribute (last dotted segment, lowercased) → the product field we can
 * fill it from. Anything absent here is left blank for manual completion.
 */
const FILL_BY_ATTRIBUTE: Record<string, BestBuyFillKey> = {
  categoryname: "categoryName",
  productname: "name",
  producttitle: "name",
  gtin: "upc",
  upc: "upc",
  brand: "brand",
  description: "description",
  longdescription: "description",
  frontzoom: "imageUrl",
  mainimage: "imageUrl",
  shopsku: "vendorSku",
  sku: "vendorSku",
  modelnumber: "vendorSku",
  productweight: "weight",
  productheight: "height",
  productwidth: "width",
  productdepth: "depth",
};

/**
 * The plain attribute name for mapping, or "" when the code is a NESTED
 * structure that must never be auto-filled.
 *
 * Two different dotted shapes exist and they mean opposite things:
 *   "Car_Amplifiers.productWeight"   category-code prefix + attribute → map it
 *   "featureBullets.1.description"   a repeating sub-structure       → do NOT
 *
 * Matching on the last segment alone conflates them: it filled Feature Bullets
 * 1-5 AND Product Documents 1-2 with the product description, because each of
 * those ends in ".description". Feature bullets are short selling points and
 * product documents are spec sheets — neither is the description, and wrong
 * content in a required Best Buy attribute fails validation on upload. So the
 * category prefix is stripped and anything still nested is left blank.
 */
function attributeKey(code: string, hierarchyCode: string): string {
  let s = code.trim();
  if (hierarchyCode && s.toLowerCase().startsWith(`${hierarchyCode.toLowerCase()}.`)) {
    s = s.slice(hierarchyCode.length + 1);
  }
  if (s.includes(".")) return ""; // still nested → not a simple attribute
  return s.toLowerCase();
}

function toColumn(a: MiraklAttribute, hierarchyCode: string): BestBuyColumn {
  const key = attributeKey(a.code, hierarchyCode);
  return {
    code: a.code,
    label: a.label || a.code,
    required: !!a.required,
    type: a.type,
    fill: key ? FILL_BY_ATTRIBUTE[key] : undefined,
  };
}

/**
 * The column set for one Best Buy category, required attributes first.
 * `categoryPath` is the assigned path ("Automotive > Car Audio > Car
 * Amplifiers"); it is resolved to the Mirakl hierarchy code the API needs.
 *
 * Returns null when the category isn't in the taxonomy or Mirakl isn't
 * configured — callers fall back rather than emit a wrong-shaped sheet.
 */
export async function getBestBuyColumnsForCategory(categoryPath: string): Promise<BestBuyColumn[] | null> {
  if (!miraklConfigured()) return null;
  const code = bestBuyCodeForPath(categoryPath);
  if (!code) return null;

  const attributes = await getCategoryAttributes(code);
  if (!attributes.length) return null;

  const cols = attributes.map((a) => toColumn(a, code));
  // Required first, each group keeping Mirakl's own ordering — the same
  // presentation as the portal's downloadable template.
  return [...cols.filter((c) => c.required), ...cols.filter((c) => !c.required)];
}

/**
 * Per-category column sets for a whole export, fetched once per DISTINCT
 * category. A 5,000-row file typically spans a few dozen categories, not
 * 1,450, so this is a few dozen calls — and identical categories across
 * projects hit the same cache below.
 */
const cache = new Map<string, { cols: BestBuyColumn[]; at: number }>();
const TTL_MS = 6 * 60 * 60 * 1000; // Mirakl publishes attribute updates daily

export async function getBestBuyColumnsForCategories(
  categoryPaths: string[],
): Promise<Map<string, BestBuyColumn[]>> {
  const out = new Map<string, BestBuyColumn[]>();
  for (const path of [...new Set(categoryPaths.filter(Boolean))]) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.at < TTL_MS) {
      out.set(path, hit.cols);
      continue;
    }
    try {
      const cols = await getBestBuyColumnsForCategory(path);
      if (cols?.length) {
        cache.set(path, { cols, at: Date.now() });
        out.set(path, cols);
      }
    } catch (e) {
      // One category failing must not sink the whole export — that category
      // falls back to the flat column set instead.
      console.warn(`[bestbuy-template] attributes for "${path}" failed:`, (e as Error).message);
    }
  }
  return out;
}

export function clearBestBuyTemplateCache(): void {
  cache.clear();
}
