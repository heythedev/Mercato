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
  | "imageUrl" | "vendorSku" | "price"
  | "weight" | "height" | "width" | "depth" | "length" | "color";

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
  productlength: "length",
  productdepth: "depth",
  // Vendor sheets carry a Color column; getProductField resolves it straight
  // out of vendorData. The value still has to clear the column's own dropdown
  // before it is written, so an off-list colour leaves the cell empty.
  color: "color",
  colour: "color",
};

/**
 * The product field a Best Buy attribute CODE should be filled from, or null
 * when we hold nothing for it.
 *
 * Shared by both export paths so the mapping can never drift between them: the
 * generated-sheet fallback in this file, and the real-template filler in
 * zip.ts, which sees these codes as its column keys.
 *
 * Three code shapes have to be told apart, and conflating them causes real
 * damage:
 *   Floor_Tiles.productWidth                              category-prefixed → map
 *   Floor_Tiles.tradeItemHierarchy.each.dimensions.width  packaging restatement → map
 *   featureBullets.1.description                          repeating group → NEVER map
 *
 * That last one is why this is not a simple last-segment match: an earlier
 * version filled all five feature bullets and both product-document fields with
 * the product description, because each code ends in ".description". A wrong
 * value in a required attribute fails Best Buy's validation and is harder to
 * spot than an empty cell.
 */
export function bestBuyFillKeyForCode(code: string): BestBuyFillKey | null {
  const raw = String(code ?? "").trim();
  if (!raw) return null;
  // Strip a leading category-code segment ("Floor_Tiles.", "Car_Amplifiers.").
  const afterPrefix = /^[A-Z][A-Za-z0-9_]*\./.test(raw) ? raw.slice(raw.indexOf(".") + 1) : raw;
  const lower = afterPrefix.toLowerCase();

  // Mirakl's packaging block restates the product's own dimensions and weight.
  if (lower.startsWith("tradeitemhierarchy.")) {
    if (lower.endsWith(".dimensions.length")) return "length";
    if (lower.endsWith(".dimensions.width")) return "width";
    if (lower.endsWith(".dimensions.height")) return "height";
    if (lower.endsWith(".weight.amount")) return "weight";
    return null; // units of measure and the rest: nothing to fill them from
  }

  // Still nested after the prefix ⇒ a repeating group, never auto-filled.
  if (lower.includes(".")) return null;
  return FILL_BY_ATTRIBUTE[lower] ?? null;
}

function toColumn(a: MiraklAttribute, hierarchyCode: string): BestBuyColumn {
  // hierarchyCode is stripped by bestBuyFillKeyForCode itself; passing the code
  // through the shared resolver keeps both export paths on one mapping table.
  void hierarchyCode;
  return {
    code: a.code,
    label: a.label || a.code,
    required: !!a.required,
    type: a.type,
    fill: bestBuyFillKeyForCode(a.code) ?? undefined,
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
