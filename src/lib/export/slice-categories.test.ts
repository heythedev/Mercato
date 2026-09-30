import { describe, expect, it } from "vitest";
import {
  UNCATEGORIZED_GROUP,
  categoriesInGroups,
  chunkFileName,
  chunkWindow,
  exportGroupOf,
  parseSliceKey,
  planSliceKeys,
  sliceKey,
} from "./category-group";

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

describe("splitting a group too big for one invocation", () => {
  it("leaves a group that fits completely alone", () => {
    expect(planSliceKeys("Rugs", 10, 700)).toEqual(["Rugs"]);
    expect(planSliceKeys("Furniture", 700, 700)).toEqual(["Furniture"]);
    expect(parseSliceKey("Rugs")).toEqual({ group: "Rugs", index: 1, total: 1 });
  });

  it("splits Furniture — the group that was setting the ceiling", () => {
    const keys = planSliceKeys("Furniture", 1799, 700);
    expect(keys).toHaveLength(3);
    expect(keys.map(parseSliceKey)).toEqual([
      { group: "Furniture", index: 1, total: 3 },
      { group: "Furniture", index: 2, total: 3 },
      { group: "Furniture", index: 3, total: 3 },
    ]);
  });

  it("the parts tile the group exactly — no row lost, none exported twice", () => {
    // The property that matters, checked against chunkWindow itself — the
    // function the export route calls to build skip/take. This test used to
    // re-derive the arithmetic, which meant it would have gone on passing
    // while the route computed something else entirely.
    for (const n of [1, 699, 700, 701, 1400, 1401, 1799, 4811]) {
      const keys = planSliceKeys("G", n, 700);
      const covered = new Set<number>();
      for (const key of keys) {
        const { index, total } = parseSliceKey(key);
        const { skip, take } = chunkWindow(n, index, total);
        // `take` is what the query asks for; Postgres returns fewer on the
        // final part, so the window is clamped the way the database clamps it.
        for (let r = skip; r < Math.min(skip + take, n); r++) {
          expect(covered.has(r)).toBe(false); // never twice
          covered.add(r);
        }
      }
      expect(covered.size).toBe(n); // never missed
    }
  });

  it("tiles a group whose row count changed since the plan was made", () => {
    // The window is derived from the CURRENT count, so a job whose project
    // gained or lost products between requests still covers what is there —
    // rather than reading past the end, or stopping short of it.
    for (const now of [1500, 1799, 2400]) {
      const covered = new Set<number>();
      for (let i = 1; i <= 3; i++) {
        const { skip, take } = chunkWindow(now, i, 3);
        for (let r = skip; r < Math.min(skip + take, now); r++) covered.add(r);
      }
      expect(covered.size, `${now} rows`).toBe(now);
    }
  });

  it("a single part covers the whole group", () => {
    expect(chunkWindow(1799, 1, 1)).toEqual({ skip: 0, take: 1799 });
  });

  it("a category name cannot forge a chunk key", () => {
    // The separator is a control character precisely so that a path full of
    // punctuation — which real Mathis and Best Buy categories are — can never
    // be read back as "part 2 of 3" and silently export a third of its rows.
    for (const name of [
      "Furniture > Dining Room > Dining Tables",
      "Home and Garden/Household Furnishings/Decor/Seasonal Decorations",
      "Outdoor (part 2 of 3)",
      "6115 - Luggage Racks",
      "Decor 1|2|3",
    ]) {
      expect(parseSliceKey(name)).toEqual({ group: name, index: 1, total: 1 });
    }
  });

  it("refuses a malformed chunk key rather than exporting the wrong window", () => {
    const sep = "\u0001";
    for (const bad of [`G${sep}0${sep}3`, `G${sep}4${sep}3`, `G${sep}x${sep}3`, `G${sep}1${sep}0`]) {
      expect(parseSliceKey(bad).total).toBe(1);
    }
  });

  it("names each part's files so they cannot overwrite one another", () => {
    // Every part builds a file named after the group; without this the job's
    // file store keeps only the last one written.
    expect(chunkFileName("Furniture.xlsx", 2, 3)).toBe("Furniture (part 2 of 3).xlsx");
    expect(chunkFileName("Missing_Mandatory_Fields.csv", 1, 3)).toBe(
      "Missing_Mandatory_Fields (part 1 of 3).csv",
    );
    // An unsplit group keeps the name it always had.
    expect(chunkFileName("Rugs.xlsx", 1, 1)).toBe("Rugs.xlsx");
    // A name with no extension still reads sensibly.
    expect(chunkFileName("Outdoor", 2, 2)).toBe("Outdoor (part 2 of 2)");
  });

  it("round-trips a group name through a key unchanged", () => {
    const name = "Home and Garden/Household Furnishings/Decor/Seasonal Decorations";
    expect(parseSliceKey(sliceKey(name, 2, 4))).toEqual({ group: name, index: 2, total: 4 });
  });
});
