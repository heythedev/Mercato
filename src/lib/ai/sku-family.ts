import { looksLikeSkuName } from "./resolve-sku";

/**
 * SKU-family category inheritance — the last, deterministic categorization tier.
 *
 * Vendor part numbers are structured <family><variant digits>: Vickerman's
 * H1PLR450 / H1PLR000 / H1PLR150 are all colorways of the same plume-reed
 * product line. When a code resists every resolver (vendor catalog, Amazon,
 * web) and stays Uncategorized, its own family often already answered the
 * question: if every RESOLVED sibling of VICK-H1PLR### landed on
 * "Decor 1 > Flowers & Plants > Faux Stems", the unresolved H1PLR150 is that
 * product type too — the vendor's nomenclature, not a model's guess.
 *
 * Guardrails, in order of importance:
 *  - Unanimity: ALL resolved siblings must share one category. A family split
 *    across leaves proves the prefix does not determine product type.
 *  - No thin fan-out: one resolved sibling may vouch for ONE unresolved code
 *    (a family of near-identical variants), never for a crowd — a single
 *    manually-assigned bundle code must not silently stamp 44 others.
 *  - Raw codes only: a product with a resolved human-readable name was already
 *    judged by the AI on real evidence; inheritance never overrides that.
 *  - Fallback stamps (confidence ≤ 0.1) are not evidence — only siblings that
 *    earned their category count.
 */

/** Inherited assignments carry this confidence: above the constrained-taxonomy
 *  accept floor (0.2) and the fallback sentinel (0.1), below cache/AI verdicts
 *  (≥ 0.8) so review UIs can still single these out. */
export const FAMILY_INHERIT_CONFIDENCE = 0.6;

/** Families shorter than this (after normalization) are brand prefixes, not
 *  product lines — "ABC" matches everything the vendor sells. */
const MIN_FAMILY_LEN = 5;

export type FamilyRow = {
  id: string;
  sku: string | null;
  name: string;
  /** Current marketplaceCategory (null/"" / "Uncategorized" = unresolved). */
  category: string | null;
  /** Current categoryPath, when the marketplace stores one. */
  path?: string | null;
  /** Current categoryConfidence. */
  confidence: number | null;
};

export type FamilyInheritance = {
  productId: string;
  category: string;
  path: string;
  confidence: number;
  /** Normalized family key the category came from (for logs/notes). */
  family: string;
  /** How many resolved siblings vouched for it. */
  siblings: number;
};

/**
 * Normalized family key of a vendor code: the code minus its trailing variant
 * digits. "VICK-H1PLR150" → "VICKH1PLR". Codes that don't end in a 2+ digit
 * run, or whose remaining family is too short to denote a product line,
 * yield null and never participate.
 */
export function skuFamilyKey(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const code = sku.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = code.match(/^([A-Z0-9]*[A-Z])(\d{2,})$/);
  const family = m?.[1];
  return family && family.length >= MIN_FAMILY_LEN ? family : null;
}

function isUnresolved(category: string | null | undefined): boolean {
  return !category || /^uncat/i.test(category.trim());
}

/**
 * Compute category inheritance for every unresolved raw-code row whose SKU
 * family has a unanimous resolved category. Pure function over the project's
 * current rows; returns only the rows to change.
 */
export function inheritFamilyCategories(rows: FamilyRow[]): FamilyInheritance[] {
  type FamilyState = { category: string | null; path: string | null; sources: number; targets: FamilyRow[] };
  const families = new Map<string, FamilyState>();

  for (const row of rows) {
    const key = skuFamilyKey(row.sku) ?? (looksLikeSkuName(row.name, row.sku) ? skuFamilyKey(row.name) : null);
    if (!key) continue;
    let fam = families.get(key);
    if (!fam) families.set(key, (fam = { category: null, path: null, sources: 0, targets: [] }));

    if (isUnresolved(row.category)) {
      // Candidate only if nothing else ever resolved it to a real name.
      if (looksLikeSkuName(row.name, row.sku)) fam.targets.push(row);
      continue;
    }
    if ((row.confidence ?? 1) <= 0.1) continue; // fallback stamp, not a judgment
    if (fam.sources === 0) {
      fam.category = row.category!;
      fam.path = row.path ?? null;
    } else if (fam.category !== row.category) {
      fam.category = ""; // disagreement — family prefix does not determine type
    }
    fam.sources++;
  }

  const out: FamilyInheritance[] = [];
  for (const [key, fam] of families) {
    if (!fam.category || !fam.targets.length) continue; // no sources, or split family
    if (fam.sources < 2 && fam.targets.length > 1) continue; // thin fan-out guard
    for (const row of fam.targets) {
      out.push({
        productId: row.id,
        category: fam.category,
        path: fam.path || fam.category,
        confidence: FAMILY_INHERIT_CONFIDENCE,
        family: key,
        siblings: fam.sources,
      });
    }
  }
  return out;
}
