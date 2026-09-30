/**
 * How a category path is turned into an output-file group.
 *
 * Mathis assigns products a full taxonomy leaf path:
 *
 *   Rugs > Rug Type > Indoor Rugs
 *   Baby & Kids > Baby & Kids Decor > Baby & Kids Rugs
 *   Baby & Kids > Kids Furniture > Daybeds
 *
 * Mathis ingests one file per DEPARTMENT (the first path segment), so the three
 * paths above belong in two files (Rugs, Baby & Kids) — not three. Grouping on the
 * full leaf path produced a separate file per subcategory, which is wrong for Mathis.
 *
 * Other marketplaces keep the existing behaviour: the full category string is the group.
 *
 * This module is deliberately dependency-free so the export UI and the server-side ZIP
 * builder can share it and always agree on the file count shown vs. produced.
 */

/** Top-level department of a taxonomy path — "Rugs > Rug Type > Indoor Rugs" → "Rugs". */
export function departmentOf(category: string): string {
  return category.split(">")[0]?.trim() || category.trim();
}

/** True when this marketplace groups export files by department instead of by full path. */
export function groupsByDepartment(marketplace: string): boolean {
  return marketplace.toLowerCase() === "mathis";
}

/**
 * The export-file group a category belongs to for the given marketplace.
 * Mathis  → top-level department  ("Rugs > Rug Type > Indoor Rugs" → "Rugs")
 * Temu    → Category > Sub-Category (drops Product Type to avoid hundreds of tiny files)
 * Wayfair → the full class string ("6115 - Luggage Racks"); one file per Wayfair
 *           class, since each class has its own upload template. Falls through to
 *           the default below (no special-casing needed).
 * Others  → the full category path unchanged
 */
export function exportGroupOf(category: string, marketplace: string): string {
  if (groupsByDepartment(marketplace)) return departmentOf(category);
  if (marketplace.toLowerCase() === "temu") {
    const parts = category.split(" > ");
    return parts.length >= 2 ? `${parts[0]} > ${parts[1]}` : category;
  }
  return category;
}

/** The group key used for rows with no usable category. Must match the export route. */
export const UNCATEGORIZED_GROUP = "__uncategorized__";

/**
 * Which categories belong to a set of export groups.
 *
 * The inverse of {@link exportGroupOf}, and it lives here so the two can never
 * drift: the export loads one slice by filtering products on these categories
 * IN SQL, and if that filter disagreed with the grouping by so much as one
 * path, a category's rows would be written into another category's file.
 *
 * Takes the project's DISTINCT categories — a cheap query — rather than its
 * products.
 */
export function categoriesInGroups(
  categories: (string | null)[],
  marketplace: string,
  groups: string[],
): { categories: string[]; includeUncategorized: boolean } {
  const wanted = new Set(groups);
  const out: string[] = [];
  let includeUncategorized = false;
  for (const cat of categories) {
    if (!cat || cat === "Uncategorized") {
      if (wanted.has(UNCATEGORIZED_GROUP)) includeUncategorized = true;
      continue;
    }
    if (wanted.has(exportGroupOf(cat, marketplace))) out.push(cat);
  }
  return { categories: out, includeUncategorized };
}

/**
 * A group too big for one invocation is built in parts.
 *
 * A slice is one output file, and one group was always one slice — so the
 * biggest department set the ceiling for the whole export. On the Mathis
 * catalogue that failed repeatedly, Furniture alone is 1,799 products; if that
 * cannot be loaded, enriched, filled and written inside a single 300s
 * invocation then no amount of splitting BETWEEN groups helps, because the
 * group itself is indivisible.
 *
 * So a slice key is either a plain group name or a group plus "part i of n".
 * The separator is a control character: a category path can contain "/", ">",
 * "-", "(" and most punctuation, and picking a printable delimiter would mean
 * a category named just so could forge a chunk key.
 */
const CHUNK_SEP = "\u0001";

export type SliceKey = { group: string; index: number; total: number };

/** `total <= 1` returns the bare group name, so an unsplit plan is unchanged. */
export function sliceKey(group: string, index: number, total: number): string {
  return total <= 1 ? group : `${group}${CHUNK_SEP}${index}${CHUNK_SEP}${total}`;
}

/** Always succeeds: anything that is not a chunk key is part 1 of 1. */
export function parseSliceKey(key: string): SliceKey {
  const parts = key.split(CHUNK_SEP);
  if (parts.length !== 3) return { group: key, index: 1, total: 1 };
  const index = Number(parts[1]);
  const total = Number(parts[2]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
    return { group: key, index: 1, total: 1 };
  }
  return { group: parts[0], index, total };
}

/**
 * Split one group into as many parts as its product count needs.
 * Returns a single bare key when it fits, so small groups look as they did.
 */
export function planSliceKeys(group: string, products: number, maxPerSlice: number): string[] {
  const total = Math.max(1, Math.ceil(products / Math.max(1, maxPerSlice)));
  if (total <= 1) return [group];
  return Array.from({ length: total }, (_, i) => sliceKey(group, i + 1, total));
}

/**
 * The slice of rows one part covers, as skip/take for the query.
 *
 * Lives beside planSliceKeys rather than in the export route because the two
 * have to agree exactly: if the parts do not tile the group, a product is
 * either exported twice or not at all, and both are silent — the file looks
 * fine, it is simply missing rows. Keeping the arithmetic in one place is also
 * what lets a test cover the code the route actually runs, instead of a
 * re-derivation of it that can drift.
 *
 * Derived from the group's CURRENT row count, not from MAX_SLICE_PRODUCTS, so
 * the parts still tile it if that setting changes while a job is running.
 */
export function chunkWindow(rows: number, index: number, total: number): { skip: number; take: number } {
  const size = Math.ceil(rows / Math.max(1, total));
  return { skip: (index - 1) * size, take: size };
}

/**
 * The name a chunk's file takes, so parts of one group do not collide in the
 * job's file store — which would silently keep only the last one written.
 * `Furniture.xlsx` → `Furniture (part 2 of 3).xlsx`.
 */
export function chunkFileName(name: string, index: number, total: number): string {
  if (total <= 1) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  return `${stem} (part ${index} of ${total})${ext}`;
}
