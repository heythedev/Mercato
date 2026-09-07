import { describe, it, expect } from "vitest";
import { implausibleWalmartCategory, parseWalmartCategoryPath, resolveWalmartLiveCategory } from "./walmart-category";

describe("parseWalmartCategoryPath", () => {
  it("strips the Home Page prefix and collapses deep paths to top level + leaf", () => {
    // Walmart returns 2–6 levels; the client's taxonomy is exactly 2, so the
    // middle segments are dropped.
    expect(parseWalmartCategoryPath("Home Page/Home Improvement/Tools/Hand Tools/Hand Saws"))
      .toEqual({
        category: "Hand Saws",
        path: "Home Improvement > Hand Saws",
      });
  });

  it("keeps a 2-level path unchanged", () => {
    expect(parseWalmartCategoryPath("Home Page/Home Improvement/Hand Saws"))
      .toEqual({
        category: "Hand Saws",
        path: "Home Improvement > Hand Saws",
      });
  });

  it("rejects Walmart's UNNAV placeholder", () => {
    // ~12% of listings carry this; it means "no navigable category", not a category.
    expect(parseWalmartCategoryPath("UNNAV")).toBeNull();
    expect(parseWalmartCategoryPath("unnav")).toBeNull();
  });

  it("rejects empty and non-string input", () => {
    expect(parseWalmartCategoryPath("")).toBeNull();
    expect(parseWalmartCategoryPath("   ")).toBeNull();
    expect(parseWalmartCategoryPath(undefined)).toBeNull();
    expect(parseWalmartCategoryPath(null)).toBeNull();
    expect(parseWalmartCategoryPath(42)).toBeNull();
  });

  it("rejects a path that is only the Home Page prefix", () => {
    expect(parseWalmartCategoryPath("Home Page/")).toBeNull();
  });
});

describe("implausibleWalmartCategory", () => {
  // Real misfilings observed on a 7,021-product catalog.
  it("rejects a trade tool filed under a non-tool top level", () => {
    expect(implausibleWalmartCategory("Bon 11-456 Electrician Chisel - 2 3 4-inch", "Toys > All Toys & Games")).toBe(true);
    expect(implausibleWalmartCategory("Bon 21-101 Lewis Pin - 1 2-inch Diameter", "Auto & Tires > Automotive Replacement Parts")).toBe(true);
    expect(implausibleWalmartCategory("Bon 24-117 Screed - 3 4-inch X 4-inch", "Auto & Tires > Automotive Replacement Parts")).toBe(true);
  });

  it("rejects a concrete texture mat filed as a doormat", () => {
    // Walmart matches on the word "Mat"; this is a concrete stamping tool.
    expect(implausibleWalmartCategory("Bon 12-597 Texture Mat - London Cobble - 17-inch", "Home > Decor > Rugs > Doormats > Shop All Doormats")).toBe(true);
  });

  it("keeps trade tools that Walmart filed correctly", () => {
    expect(implausibleWalmartCategory("Bon 13-521 Trowel-Pointed Nose 15-3 4-inch", "Home Improvement > Tile > Tile Tools & Materials > Tile Trowels")).toBe(false);
    expect(implausibleWalmartCategory("Bon 12-227 Bull Float - Mag 24-inch", "Home Improvement > Building Materials > Masonry Tools")).toBe(false);
    expect(implausibleWalmartCategory("Bon 11-386 Line Pin - 6-inch", "Home Improvement > Hardware > Fasteners > Pins, Rings and Clips")).toBe(false);
  });

  it("does not touch products that are not trade tools", () => {
    // Most of the catalog. Walmart's category stands unchallenged.
    expect(implausibleWalmartCategory("Annabel Velvet Full Headboard", "Home > Furniture > Bedroom > Full Headboards")).toBe(false);
    expect(implausibleWalmartCategory("Caroline's Treasures Dolphin Throw Pillow", "Home > Decor > Throw Pillows")).toBe(false);
  });

  it("keeps decor products whose names merely contain a tool word", () => {
    // "Hawk" is both a plastering tool and a bird — a Hawk Door Mat really is a
    // doormat, and rejecting it would be the error.
    expect(implausibleWalmartCategory("Caroline's Treasures Hawk Door Mat", "Home > Decor > Rugs > Doormats > Shop All Doormats")).toBe(false);
    expect(implausibleWalmartCategory("Caroline's Treasures Hawk Throw Pillow", "Home > Teens' Rooms > Teens' Decor > Teens' Decorative Pillows")).toBe(false);
  });

  it("keeps genuine cross-category trade products", () => {
    // Leather work gloves really do belong under Clothing > Gloves.
    expect(implausibleWalmartCategory("Bon 84-375 Gloves - Leather Palm - XL", "Clothing > Bags & Accessories > Hats, Gloves & Scarves > Gloves")).toBe(false);
  });
});

describe("resolveWalmartLiveCategory", () => {
  // Real approved-sheet values (walmart_approved_categories.csv), verified
  // live against Walmart's own taxonomy on 2026-09-03.
  const normalize = (s: string) => s.trim().toLowerCase();
  const validTypes = new Map([
    [normalize("Vehicle Rotors"), "Vehicle Rotors"],
    [normalize("Disc Brake Calipers"), "Disc Brake Calipers"],
  ]);

  it("resolves both the Spec Product Type and its approved category with no path to check", () => {
    // The seller-owned lookup (our own listing) carries no separate breadcrumb.
    expect(resolveWalmartLiveCategory("R1 Concepts Brake Rotor Set", "Vehicle Rotors", null, normalize, validTypes))
      .toEqual({
        specType: "Vehicle Rotors",
        category: { category: "Vehicles, Parts & Accessories", path: "Vehicles, Parts & Accessories > Vehicle Rotors" },
        rejected: false,
      });
  });

  it("canonicalizes a near-miss answer (case/whitespace) onto the listed value", () => {
    const result = resolveWalmartLiveCategory("A rotor", "  vehicle rotors ", null, normalize, validTypes);
    expect(result.specType).toBe("Vehicle Rotors");
    expect(result.rejected).toBe(false);
  });

  it("rejects a Spec Product Type not on the local valid-type list", () => {
    const result = resolveWalmartLiveCategory("Something", "Not A Real Type", null, normalize, validTypes);
    expect(result).toEqual({ specType: null, category: null, rejected: true });
  });

  it("accepts the type verbatim when the local taxonomy is unavailable (empty map)", () => {
    const result = resolveWalmartLiveCategory("Something", "Whatever Walmart Says", null, normalize, new Map());
    expect(result.specType).toBe("Whatever Walmart Says");
    expect(result.rejected).toBe(false);
  });

  it("rejects a whole-catalog match whose own breadcrumb is implausible for the product", () => {
    // Same real misfiling pattern as implausibleWalmartCategory's own tests —
    // a trade tool's Product Type must not be trusted when Walmart's own
    // department for THIS search result is a non-tool top level.
    const result = resolveWalmartLiveCategory(
      "Bon 21-101 Lewis Pin - 1 2-inch Diameter",
      "Disc Brake Calipers",
      ["Auto & Tires", "Automotive Replacement Parts"],
      normalize,
      validTypes,
    );
    expect(result).toEqual({ specType: null, category: null, rejected: true });
  });

  it("trusts a whole-catalog match whose breadcrumb is plausible", () => {
    const result = resolveWalmartLiveCategory(
      "R1 Concepts Brake Caliper",
      "Disc Brake Calipers",
      ["Auto & Tires", "Automotive Replacement Parts", "Brakes & Brake Parts"],
      normalize,
      validTypes,
    );
    expect(result.specType).toBe("Disc Brake Calipers");
    expect(result.category?.category).toBe("Vehicles, Parts & Accessories");
  });

  it("returns nothing usable when there is no productType at all", () => {
    expect(resolveWalmartLiveCategory("Anything", null, null, normalize, validTypes))
      .toEqual({ specType: null, category: null, rejected: false });
    expect(resolveWalmartLiveCategory("Anything", "", null, normalize, validTypes))
      .toEqual({ specType: null, category: null, rejected: false });
  });

  it("a type resolving no approved category still counts as a valid spec type, just with no category shortcut", () => {
    const noCategoryMap = new Map([[normalize("Orphan Type"), "Orphan Type"]]);
    const result = resolveWalmartLiveCategory("Something", "Orphan Type", null, normalize, noCategoryMap);
    expect(result.specType).toBe("Orphan Type");
    expect(result.category).toBeNull();
    expect(result.rejected).toBe(false);
  });
});
