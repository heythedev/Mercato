/**
 * Deciding whether Walmart's own category for a product is usable.
 *
 * Verification matches each product to a real Walmart listing, and that listing
 * carries Walmart's category path. For a Walmart export that path is the
 * authoritative answer and is far more specific than a model guess
 * ("Home Improvement > Paint > Paint Supplies & Tools > Putty Knives" rather
 * than "Tools"), so it is preferred over AI categorization.
 *
 * But Walmart's own filing is not always right. Measured on a real 7,021-product
 * catalog, ~13% of Bon masonry tools sat under a non-tool top level:
 *
 *   Bon 11-456 Electrician Chisel      → Toys > All Toys & Games
 *   Bon 21-101 Lewis Pin               → Auto & Tires > Replacement Auto Parts
 *   Bon 12-597 Texture Mat             → Home > Decor > Rugs > Doormats
 *   Bon 32-691 Animal Track Stamp      → Arts Crafts & Sewing > Scrapbooking
 *
 * Those are keyword-driven mistakes in Walmart's data ("Mat" → doormat, "Stamp"
 * → scrapbooking) riding along with an otherwise correct product match. This
 * module rejects them so they fall through to the AI instead of being accepted
 * silently.
 */

/** Names that identify a masonry / concrete / building trade tool. */
const TRADE_PRODUCT_RE =
  /\b(trowel|float|screed|jointer|groover|edger|darby|bull ?float|hawk|mag float|tamper|mortar|masonry|concrete|stamp(?:ing)? (?:mat|tool|skin)|texture (?:mat|roller|skin)|skinny mat|floppy mat|chisel|striking tool|brick|paver|rebar|lewis pin|line pin|corner tool|finishing tool)\b/i;

/** Top-level categories a trade tool should never sit in. */
const NON_TRADE_TOPS = new Set([
  "Toys",
  "Baby",
  "Arts Crafts & Sewing",
  "Auto & Tires",
  "Beauty",
  "Food",
  "Personal Care",
  "Pets",
  "Sports & Outdoors",
]);

/**
 * Sub-paths that are wrong for a trade tool even under an otherwise plausible
 * top level — "Home > Decor > Rugs > Doormats" for a concrete texture mat, or a
 * kitchen-gadget path for a sand-bag funnel.
 */
const NON_TRADE_PATH_RE =
  /\b(doormat|rugs?|decor|throw pillow|bedding|headboard|kitchen (?:tools|gadgets|dining)|scrapbook|stamping|womens? shoes|mens? shoes)\b/i;

/**
 * Words meaning the product really is a home/decor item, even though another
 * token in its name looks like a trade tool. "Hawk" is both a plastering tool
 * and a bird: a "Hawk Door Mat" or "Hawk Throw Pillow" from a decor vendor
 * belongs under Doormats, and rejecting it would itself be the error.
 */
const DECOR_PRODUCT_RE =
  /\b(door ?mat|throw pillow|pillow|blanket|tapestry|wall art|art print|canvas|garden flag|mailbox cover|coaster|mouse ?pad|apron|towel|headboard|duvet|quilt|curtain)\b/i;

/**
 * True when Walmart's category path is implausible for this product and should
 * be discarded in favour of AI categorization.
 *
 * Deliberately narrow — it only fires for trade tools filed somewhere
 * incompatible. Genuine cross-category products (leather work gloves under
 * Clothing > Gloves, knee pads under safety equipment) must survive, and on a
 * real catalog this rejects well under 1% of paths.
 */
export function implausibleWalmartCategory(productName: string, path: string): boolean {
  if (!TRADE_PRODUCT_RE.test(productName)) return false; // not a trade tool — trust Walmart
  if (DECOR_PRODUCT_RE.test(productName)) return false;  // decor item, correctly filed
  const top = path.split(" > ")[0] ?? "";
  if (NON_TRADE_TOPS.has(top)) return true;
  return NON_TRADE_PATH_RE.test(path);
}

/**
 * Normalize a raw Walmart `categoryPath` into a usable category + path, or null
 * when it carries no answer.
 *
 * Walmart prefixes every path with "Home Page/" and uses the literal "UNNAV"
 * for items with no navigable category — neither is a category, so both are
 * stripped or rejected here rather than at the call site.
 */
export function parseWalmartCategoryPath(
  raw: unknown,
): { category: string; path: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toUpperCase() === "UNNAV") return null;
  const segments = trimmed
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s && s.toLowerCase() !== "home page");
  // Require at least 2 segments. A single segment is too broad to be useful.
  if (segments.length < 2) return null;
  // Walmart returns 2–6 level paths. The client's taxonomy is always expressed
  // as exactly 2 levels: top-level Category + Product Type (most specific leaf).
  // Collapse deeper paths to [first segment] > [last segment] so "Party &
  // Occasions > Halloween > Costumes > Boy's Career Costumes" becomes
  // "Party & Occasions > Boy's Career Costumes".
  const limited = segments.length > 2
    ? [segments[0], segments[segments.length - 1]]
    : segments;
  return {
    category: limited[limited.length - 1],
    path: limited.join(" > "),
  };
}
