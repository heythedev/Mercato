/**
 * What a marketplace DOES, as data rather than as branches.
 *
 * `catalog.ts` already says which marketplaces exist — id, label, domain, who
 * may use them. It says nothing about how any of them behaves, so behaviour
 * lives as `marketplace === "mathis"` comparisons scattered through the
 * export, the categoriser and the verifier. Adding a marketplace therefore
 * means finding every one of those and deciding whether it applies, and the
 * ones nobody finds are the bugs: a new marketplace silently inherits
 * whatever the `else` branch happened to do.
 *
 * So each marketplace declares its traits here and the engine reads traits.
 * Two consequences worth the trouble:
 *
 *   1. Adding a marketplace is adding an entry, and the compiler lists what
 *      must be decided rather than leaving it to be discovered in production.
 *   2. A marketplace nobody has declared still WORKS — DEFAULT_PROFILE is the
 *      conservative reading, and conservative means claiming no capability a
 *      template has not demonstrated.
 *
 * This is deliberately a trait registry, not a plugin interface. Traits are
 * cheap to add and migrate one call site at a time; an interface would need
 * every marketplace to implement every method on the day it lands.
 */

export type MarketplaceProfile = {
  id: string;

  /**
   * The template ships a per-category requirement matrix — a "Columns" sheet
   * saying REQUIRED / RECOMMENDED / OPTIONAL / NA per attribute per category.
   *
   * False is not a gap. Walmart's templates carry no such sheet, so there is
   * no per-category rule to narrow by, and the honest answer is the full
   * column list. Inferring one would be guessing which cells a category wants.
   */
  requirementMatrix: boolean;

  /**
   * The root segment a category path carries inside the template's own
   * vocabulary. Mathis stores "Furniture > Dining" but its dropdowns and its
   * matrix both say "Mathis Home/Furniture/Dining".
   */
  categoryRoot?: string;

  /**
   * Category segments as the catalogue stores them, and as the template
   * expects them. Everything here stores " > " today; templates differ.
   */
  storedSeparator: string;
  templateSeparator: string;

  // ── Export traits ────────────────────────────────────────────────────────

  /**
   * The template carries offer columns (price, stock, logistics) that must
   * ship EMPTY. Mathis imports offers separately and rejects a product feed
   * that fills them, so writing a correct-looking price breaks the upload.
   */
  excludesOfferColumns: boolean;

  /**
   * Dropdown option lists are reached through the workbook's DEFINED NAMES
   * rather than by joining ReferenceData on the header text.
   *
   * Mathis names every list (Validation_<hash>_product_RUG_SHAPE); the others
   * do not, and for them a defined name can point at a stale range while the
   * ReferenceData column beside it holds the true list.
   */
  dropdownsByDefinedName: boolean;

  /**
   * Seed the category column's dropdown from Mercato's own taxonomy when the
   * workbook does not declare one. Only safe where Mercato holds that
   * marketplace's authoritative category list.
   */
  categoryDropdownFromTaxonomy: boolean;

  /**
   * Column keys are attribute CODES scoped to a category
   * ("Floor_Tiles.productWidth") rather than human labels, so a column only
   * applies to products in its own category and is resolved through the
   * code→field map.
   */
  categoryScopedColumnCodes: boolean;

  /**
   * Dimension cells take a bare decimal. The template rejects any value
   * carrying a unit mark, so 2' 6" has to become 30.
   */
  dimensionsAsDecimal: boolean;

  /**
   * Mandatory cells this marketplace cannot get from the vendor sheet are
   * looked up in a product catalogue (Synccentric for identity and
   * attributes, Keepa for measurements) before the export runs.
   *
   * On where the sheet is thin and the template is demanding, and that is a
   * judgement about the TEMPLATE, not about the data — every lookup costs a
   * Synccentric search, so a marketplace whose templates ask for little
   * should not be paying for one.
   */
  enrichesFromCatalog: boolean;

  /**
   * A product with no category of its own inherits the category the template
   * declares. Right where one template serves one category; wrong where a
   * template spans many, which is why it is not the default.
   */
  templateCategoryFallback: boolean;
};

/**
 * What an undeclared marketplace gets.
 *
 * Every capability off. A trait turned on asserts something about a file
 * format — that a sheet exists, that a path is prefixed — and asserting that
 * about a template nobody has looked at is how a new marketplace ships broken
 * output. Off means the engine falls back to what works everywhere.
 */
export const DEFAULT_PROFILE: Omit<MarketplaceProfile, "id"> = {
  requirementMatrix: false,
  storedSeparator: " > ",
  templateSeparator: "/",
  excludesOfferColumns: false,
  // Joining ReferenceData by header name is the behaviour that works for
  // every marketplace but Mathis, so it is what an undeclared one gets.
  dropdownsByDefinedName: false,
  categoryDropdownFromTaxonomy: false,
  categoryScopedColumnCodes: false,
  dimensionsAsDecimal: false,
  enrichesFromCatalog: false,
  templateCategoryFallback: false,
};

const PROFILES: Record<string, Partial<MarketplaceProfile>> = {
  mathis: {
    requirementMatrix: true,
    enrichesFromCatalog: true,
    categoryRoot: "Mathis Home",
    excludesOfferColumns: true,
    dropdownsByDefinedName: true,
    categoryDropdownFromTaxonomy: true,
    dimensionsAsDecimal: true,
  },
  bestbuy: {
    requirementMatrix: true,
    categoryScopedColumnCodes: true,
    enrichesFromCatalog: true,
  },
  walmart: {
    templateCategoryFallback: true,
  },

  // Declared with no traits rather than left out, so the list reads as a
  // decision that was made: these templates were checked and carry none.
  temu: {},
  sears: {},
  // eBay's upload file is a flat CSV with no "Columns" sheet and no
  // per-category matrix, so every trait here stays off. What it DOES carry
  // that no other marketplace does — required columns the template itself
  // never describes — is read from a filled reference file instead; see
  // ebay-template.ts.
  //
  // Catalogue enrichment is on. eBay asks for Colour, Size and Style per
  // product and this vendor's sheets carry Material and little else, so the
  // columns were shipping empty with nothing wrong anywhere — the wiring
  // worked, there was simply nothing to read. Synccentric returns colour and
  // size in the same response as everything else, so the answer was already
  // being fetched for two other marketplaces and thrown away for this one.
  ebay: { enrichesFromCatalog: true },
  amazon: {},
  wayfair: {},
};

/** Stored marketplaces that mean the same profile ("amazon_us" → "amazon"). */
function canonical(marketplace: string): string {
  const m = String(marketplace ?? "").trim().toLowerCase();
  if (m.startsWith("amazon")) return "amazon";
  if (m === "best buy" || m === "best_buy") return "bestbuy";
  return m;
}

/**
 * The profile for a marketplace, declared or not.
 *
 * Never throws and never returns undefined: an unknown marketplace is a new
 * one, not an error, and the caller's job is to keep working.
 */
export function profileFor(marketplace: string): MarketplaceProfile {
  const id = canonical(marketplace);
  return { id, ...DEFAULT_PROFILE, ...(PROFILES[id] ?? {}) };
}

/** Whether this marketplace's templates carry a per-category requirement matrix. */
export function hasRequirementMatrix(marketplace: string): boolean {
  return profileFor(marketplace).requirementMatrix;
}

/**
 * A stored category ("Furniture > Dining Room") as the template spells it
 * ("Mathis Home/Furniture/Dining Room").
 *
 * A value already in template form is returned untouched, so this is safe to
 * apply to either.
 */
export function toTemplateCategoryPath(marketplace: string, stored: string): string {
  const p = profileFor(marketplace);
  const raw = String(stored ?? "");
  if (!raw.includes(p.storedSeparator) || raw.includes(p.templateSeparator)) return raw;
  const joined = raw
    .split(p.storedSeparator)
    .map((s) => s.trim())
    .join(p.templateSeparator);
  return p.categoryRoot ? `${p.categoryRoot}${p.templateSeparator}${joined}` : joined;
}
