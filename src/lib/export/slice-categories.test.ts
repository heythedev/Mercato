import { describe, expect, it } from "vitest";
import { UNCATEGORIZED_GROUP, categoriesInGroups, exportGroupOf } from "./category-group";

/**
 * Which rows belong to a slice.
 *
 * A large export is built one group at a time, and each pass now loads only
 * that group's products — the filter goes into SQL instead of loading the
 * whole catalogue and discarding most of it. Measured on the 4,811-product
 * Mathis project that was failing: 63.3s to load everything, against 14.0s for
 * the biggest slice, and the old code paid the 63.3s on every one of twelve
 * passes. That was most of a 300s invocation spent fetching rows the pass was
 * going to throw away, which is why it timed out.
 *
 * The risk the SQL filter introduces is disagreement: if it and exportGroupOf
 * ever part company, a category's products are written into another category's
 * file and the export is silently wrong rather than slow. These tests pin the
 * two together.
 */

const MATHIS = "mathis";

const CATS = [
  "Furniture > Dining Room > Dining Tables",
  "Furniture > Bedroom > Dressers & Chests > Dressers",
  "Outdoor > Outdoor Seating > Outdoor Sectionals",
  "Outdoor > Outdoor Bar > Outdoor Bars & Carts > Carts",
  "Decor 1 > Lighting > Chandeliers",
  "Rugs > Rug Type > Indoor Rugs",
  null,
  "Uncategorized",
];

describe("slice category filter", () => {
  it("selects every category of the requested department, and no other", () => {
    const { categories, includeUncategorized } = categoriesInGroups(CATS, MATHIS, ["Furniture"]);
    expect(categories).toEqual([
      "Furniture > Dining Room > Dining Tables",
      "Furniture > Bedroom > Dressers & Chests > Dressers",
    ]);
    expect(includeUncategorized).toBe(false);
  });

  it("agrees with exportGroupOf for every category it returns", () => {
    // The invariant that keeps a file's contents correct. Checked across every
    // department rather than one, because a single disagreement is enough.
    for (const group of ["Furniture", "Outdoor", "Decor 1", "Rugs"]) {
      const { categories } = categoriesInGroups(CATS, MATHIS, [group]);
      expect(categories.length).toBeGreaterThan(0);
      for (const c of categories) expect(exportGroupOf(c, MATHIS)).toBe(group);
    }
  });

  it("covers the catalogue exactly once across all groups", () => {
    // No row may be dropped (missing from the export) or claimed twice
    // (written into two files). Both are silent failures.
    const groups = [...new Set(CATS.map((c) =>
      !c || c === "Uncategorized" ? UNCATEGORIZED_GROUP : exportGroupOf(c, MATHIS)))];
    const seen: string[] = [];
    let uncategorized = 0;
    for (const g of groups) {
      const r = categoriesInGroups(CATS, MATHIS, [g]);
      seen.push(...r.categories);
      if (r.includeUncategorized) uncategorized++;
    }
    expect(seen.slice().sort()).toEqual(CATS.filter((c): c is string => !!c && c !== "Uncategorized").sort());
    expect(new Set(seen).size).toBe(seen.length); // claimed once, never twice
    expect(uncategorized).toBe(1);
  });

  it("picks up null AND the literal 'Uncategorized' together", () => {
    // Both spellings exist in live data and both go to the same file.
    const r = categoriesInGroups(CATS, MATHIS, [UNCATEGORIZED_GROUP]);
    expect(r.includeUncategorized).toBe(true);
    expect(r.categories).toEqual([]);
  });

  it("never treats an uncategorized row as a real category", () => {
    // `{ marketplaceCategory: { in: [...] } }` cannot match null, so a null
    // leaking into the category list would silently drop those rows.
    const r = categoriesInGroups(CATS, MATHIS, ["Furniture", UNCATEGORIZED_GROUP]);
    expect(r.categories).not.toContain(null);
    expect(r.categories.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
  });

  it("batches several groups in one pass", () => {
    const r = categoriesInGroups(CATS, MATHIS, ["Rugs", "Decor 1"]);
    expect(r.categories.sort()).toEqual([
      "Decor 1 > Lighting > Chandeliers",
      "Rugs > Rug Type > Indoor Rugs",
    ]);
  });

  it("returns nothing for a group the project has no rows for", () => {
    // The caller turns an empty result into a filter that selects NOTHING.
    // Returning everything instead would build the whole catalogue into one
    // group's file.
    expect(categoriesInGroups(CATS, MATHIS, ["Mattress"])).toEqual({
      categories: [],
      includeUncategorized: false,
    });
  });

  it("groups by full path for a marketplace that is not Mathis", () => {
    // Mathis is the only marketplace that collapses to a department; Best Buy
    // and the rest keep the full path, and the slice must follow whichever
    // rule the grouping used.
    const cats = ["Home and Garden/Household Furnishings/Decor/Seasonal Decorations"];
    const r = categoriesInGroups(cats, "bestbuy", [cats[0]]);
    expect(r.categories).toEqual(cats);
    expect(categoriesInGroups(cats, "bestbuy", ["Home and Garden"]).categories).toEqual([]);
  });
});
