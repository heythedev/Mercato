import { describe, expect, it } from "vitest";
import {
  approvedCategoryForType,
  loadWalmartApprovedMap,
  mapToApprovedCategory,
} from "./walmart-taxonomy";

// The client rejected the Walmart output sheet because its Product Category
// values came from a legacy 75-value template list with ZERO overlap with
// Walmart's real category structure. The approved mapping (their 5.2k-row
// Category & Product Type sheet, committed as walmart_approved_categories.csv)
// is now the only export target.
describe("Walmart approved category structure", () => {
  it("loads the client's full mapping", () => {
    const m = loadWalmartApprovedMap();
    expect(m).not.toBeNull();
    expect(m!.byType.size).toBeGreaterThan(5000);
    // The placeholder rows never survive conversion.
    expect(m!.categories).not.toContain("UNPUBLISHED");
    expect(m!.categories).not.toContain("default");
  });

  it("maps a Spec Product Type to its approved category 1:1", () => {
    expect(approvedCategoryForType("Vehicle Rotors")).toBe("Vehicles, Parts & Accessories");
    expect(approvedCategoryForType("vehicle rotors")).toBe("Vehicles, Parts & Accessories"); // case-insensitive
    expect(approvedCategoryForType("Not A Real Type")).toBeNull();
  });

  it("prefers the spec-type mapping over path wording", () => {
    // Even if the assigned path says something else, the type's own category wins.
    const viaType = mapToApprovedCategory("Vehicle Rotors", "Home > Decor > Vases");
    expect(viaType).toBe("Vehicles, Parts & Accessories");
  });

  it("falls back to alias/word mapping of the assigned path", () => {
    expect(mapToApprovedCategory(null, "Home > Furniture > Sofas")).toBe("Home & Garden");
    expect(mapToApprovedCategory(null, "Electronics > Audio > Headphones")).toBe("Electronics");
    expect(mapToApprovedCategory(null, "Toys > Action Figures")).toBe("Toys & Games");
  });

  it("returns null rather than an off-list guess", () => {
    expect(mapToApprovedCategory(null, "zzz qqq xyzzy")).toBeNull();
    expect(mapToApprovedCategory(null, null)).toBeNull();
  });

  it("every mapped value is from the approved list", () => {
    const m = loadWalmartApprovedMap()!;
    const approved = new Set(m.categories);
    for (const probe of ["Home > Rugs", "Kitchen > Cookware", "Pet > Dog Beds", "Office > Binders"]) {
      const v = mapToApprovedCategory(null, probe);
      if (v !== null) expect(approved.has(v)).toBe(true);
    }
  });
});
