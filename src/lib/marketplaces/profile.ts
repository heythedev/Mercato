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
};

const PROFILES: Record<string, Partial<MarketplaceProfile>> = {
  // Mirakl-built templates, and the two that publish a Columns sheet.
  mathis: {
    requirementMatrix: true,
    categoryRoot: "Mathis Home",
  },
  bestbuy: {
    requirementMatrix: true,
  },

  // Declared so the list reads as a decision rather than an omission: these
  // templates were checked and carry no requirement matrix.
  walmart: {},
  temu: {},
  sears: {},
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
