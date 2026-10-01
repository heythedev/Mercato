import { loadMathisCategoryPaths } from "@/lib/ai/mathis-taxonomy";
import { loadBestBuyCategoryPaths } from "@/lib/ai/bestbuy-taxonomy";
import { loadSearsCategoryPaths } from "@/lib/ai/sears-taxonomy";
import { loadTemuCategoryPaths } from "@/lib/ai/temu-taxonomy";
import { loadWayfairCategoryPaths } from "@/lib/ai/wayfair-taxonomy";
import { loadWalmartCategoryPaths } from "@/lib/ai/walmart-taxonomy";

/**
 * The closed set of categories a product may be given, per marketplace.
 *
 * Every marketplace already ships one — mathis_categories.csv and its
 * siblings, the same files the batch categoriser is held to. This module
 * exists so a SECOND way of assigning a category cannot be held to a
 * different standard than the first.
 *
 * The rule it enforces is one sentence: **a category is chosen from the list,
 * never composed.** Mercato's own MCP write tool took an arbitrary string, and
 * the failure that permits is quiet rather than loud — write "Sofas" instead
 * of "Furniture > Living Room > Sofas" and the export reads the first segment
 * as a department, invents a group no template matches, and fills the wrong
 * workbook. Worse, the product now HAS a category, so the real categoriser
 * skips it forever. Nothing errors; a client just gets the wrong sheet.
 *
 * So anything proposed is resolved against the list and rejected if it is not
 * there, and what gets written is the canonical string from the file rather
 * than whatever spelling arrived.
 */

type Loader = () => string[];

const LOADERS: Record<string, Loader> = {
  mathis: loadMathisCategoryPaths,
  bestbuy: loadBestBuyCategoryPaths,
  sears: loadSearsCategoryPaths,
  temu: loadTemuCategoryPaths,
  wayfair: loadWayfairCategoryPaths,
  walmart: loadWalmartCategoryPaths,
};

/**
 * Every valid path for a marketplace, or null when there is no taxonomy for
 * it. Null means "cannot be checked" and callers must refuse rather than wave
 * the value through — an unknown marketplace is exactly when a typo would go
 * unnoticed.
 */
export function categoryPathsFor(marketplace: string): string[] | null {
  const load = LOADERS[marketplace.trim().toLowerCase()];
  if (!load) return null;
  try {
    const paths = load();
    return paths.length ? paths : null;
  } catch {
    // A missing or unparseable CSV is a deployment problem, not a reason to
    // start accepting unvalidated categories.
    return null;
  }
}

/**
 * The comparison key for a path.
 *
 * Segments are trimmed and re-joined with a single " > ", and the result is
 * lowercased, so "furniture>living room>sofas" and
 * "Furniture  >  Living Room > Sofas" both find the canonical entry. This is
 * for MATCHING only — the canonical spelling is what gets stored.
 */
export function categoryKey(path: string): string {
  return path
    .split(">")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" > ")
    .toLowerCase();
}

export type CategoryIndex = {
  marketplace: string;
  paths: string[];
  /** key → canonical spelling */
  byKey: Map<string, string>;
};

/** Built once per batch rather than per product — these lists run to thousands. */
export function categoryIndex(marketplace: string): CategoryIndex | null {
  const paths = categoryPathsFor(marketplace);
  if (!paths) return null;
  const byKey = new Map<string, string>();
  // First spelling wins, so a duplicate differing only in case cannot make the
  // canonical form depend on file order further down.
  for (const p of paths) {
    const k = categoryKey(p);
    if (!byKey.has(k)) byKey.set(k, p);
  }
  return { marketplace, paths, byKey };
}

/** The canonical path for a proposed one, or null when it is not in the list. */
export function canonicalCategory(index: CategoryIndex, proposed: string): string | null {
  return index.byKey.get(categoryKey(proposed)) ?? null;
}

export type ProposedAssignment = { productId: string; category: string; confidence?: number };
export type AcceptedAssignment = { productId: string; category: string; confidence: number };
export type RejectedAssignment = { productId: string; category: string; reason: string };

/**
 * Split proposals into what may be written and what may not.
 *
 * Partial rather than all-or-nothing on purpose: a batch where 39 of 40 are
 * right should write 39. The rejected products stay uncategorised, so the
 * caller's next batch picks them up again — the retry is the existing loop
 * rather than special handling.
 */
export function resolveAssignments(
  index: CategoryIndex,
  proposals: ProposedAssignment[],
): { accepted: AcceptedAssignment[]; rejected: RejectedAssignment[] } {
  const accepted: AcceptedAssignment[] = [];
  const rejected: RejectedAssignment[] = [];
  const seen = new Set<string>();

  for (const p of proposals) {
    const productId = String(p.productId ?? "").trim();
    const category = String(p.category ?? "").trim();

    if (!productId) {
      rejected.push({ productId, category, reason: "No productId" });
      continue;
    }
    // Two assignments for one product in one batch is a mistake either way;
    // picking one silently would make the result depend on array order.
    if (seen.has(productId)) {
      rejected.push({ productId, category, reason: "Listed twice in this batch" });
      continue;
    }
    seen.add(productId);

    if (!category) {
      rejected.push({ productId, category, reason: "No category given" });
      continue;
    }

    const canonical = canonicalCategory(index, category);
    if (!canonical) {
      rejected.push({
        productId,
        category,
        reason: `Not a ${index.marketplace} category. Choose an exact path from the list.`,
      });
      continue;
    }

    // Absent confidence is treated as certain-enough-to-keep but not asserted:
    // 0.8 sits above the 0.6 the reuse cache requires, below a claimed 1.0.
    const raw = typeof p.confidence === "number" && Number.isFinite(p.confidence) ? p.confidence : 0.8;
    accepted.push({ productId, category: canonical, confidence: Math.min(1, Math.max(0, raw)) });
  }

  return { accepted, rejected };
}

/**
 * The distinct next segment under a prefix, for a taxonomy too large to hand
 * over whole.
 *
 * Nothing needs it today — the largest loaded list is Best Buy at 1,450 — but
 * that is close enough to the ceiling that one CSV update flips it, and the
 * alternative when a list does not fit is truncation, which offers a choice
 * that silently excludes the right answer. Drilling a level at a time keeps
 * the options bounded while never naming a path that is not real.
 */
export function nextSegments(paths: string[], prefix?: string): string[] {
  const pre = (prefix ?? "").trim();
  const preKey = pre ? categoryKey(pre) : "";
  const depth = pre ? preKey.split(" > ").length : 0;
  const out = new Set<string>();

  for (const path of paths) {
    const segs = path.split(" > ").map((s) => s.trim());
    if (pre) {
      const headKey = segs.slice(0, depth).join(" > ").toLowerCase();
      if (headKey !== preKey) continue;
    }
    const next = segs.slice(0, depth + 1).join(" > ");
    if (next) out.add(next);
  }
  return [...out].sort();
}

/**
 * Whether a whole taxonomy is small enough to send with a batch.
 *
 * Measured, not guessed — what the loaders actually return: Sears 329,
 * Walmart 492, Mathis 504, Temu 717, Best Buy 1,450. (Walmart's 5,242-line
 * approved-categories file is a product-type MAPPING, not the assignable
 * paths.) All fit today; Best Buy is near enough the line to be worth the
 * drill-down path existing.
 */
export const INLINE_TAXONOMY_MAX = 1_500;
