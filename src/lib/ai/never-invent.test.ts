import { describe, it, expect } from "vitest";
import { neverInventColumn } from "./match-dropdown";

/**
 * What the model is not allowed to answer.
 *
 * Every entry here was found in real exported data: on one Best Buy project all
 * 99 stored values were the model's own, including physical measurements it had
 * never been told and two compliance declarations that are the seller's to
 * make. The guard existed but was applied only to free-text cells, so every
 * mandatory column with a Yes/No dropdown went to the model unguarded.
 *
 * The rule is the same in each case: a wrong value here is worse than an empty
 * cell, because an empty cell gets fixed by an operator and a wrong one ships.
 */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

describe("values the model must never invent", () => {
  it("refuses identifiers — a fabricated one attaches the listing to someone else's product", () => {
    for (const c of ["UPC", "GTIN", "EAN", "Barcode", "ASIN", "ISBN", "Model Number", "Shop SKU", "MPN"]) {
      expect(neverInventColumn(norm(c))).toBe(true);
    }
  });

  it("refuses media — a made-up URL passes import and then fails in public", () => {
    for (const c of ["Main Image", "Front Zoom Image", "Video URL", "Product Link"]) {
      expect(neverInventColumn(norm(c))).toBe(true);
    }
  });

  it("refuses physical measurements — they are facts, and carriers price on them", () => {
    for (const c of [
      "Product Weight",
      "Product Height",
      "Product Width",
      "Product Length",
      "Product Depth",
      "Trade Item Hierarchy Each Dimensions Length",
      "Trade Item Hierarchy Each Weight Amount",
      "DIMH",
    ]) {
      expect(neverInventColumn(norm(c))).toBe(true);
    }
  });

  it("refuses the unit that goes with a measurement", () => {
    // A unit beside an empty measurement says nothing; a unit beside a guessed
    // one lends it false authority.
    expect(neverInventColumn(norm("Trade Item Hierarchy Each Weight Unit Of Measure"))).toBe(true);
    expect(neverInventColumn(norm("Trade Item Hierarchy Each Dimensions Unit Of Measure"))).toBe(true);
  });

  it("refuses compliance declarations — they are legal statements the seller makes", () => {
    // These were being answered from a Yes/No dropdown, which is exactly why
    // they slipped through: the guard only ran on free-text cells.
    expect(neverInventColumn(norm("California Proposition 65 Warning: Type"))).toBe(true);
    expect(neverInventColumn(norm("californiaProposition65Warning.type"))).toBe(true);
    expect(neverInventColumn(norm("Contains Intentionally Added PFAS"))).toBe(true);
  });

  it("refuses safety and shipping declarations — a wrong answer is a shipping violation", () => {
    expect(neverInventColumn(norm("Contains Embedded Battery"))).toBe(true);
    expect(neverInventColumn(norm("Lithium Battery Type"))).toBe(true);
    expect(neverInventColumn(norm("Hazmat Class"))).toBe(true);
  });

  it("still allows the descriptive attributes the fill exists to answer", () => {
    // Blocking too much is its own failure: these are the columns an operator
    // would otherwise type by hand, and they are inferable from the product.
    for (const c of [
      "Colour",
      "Finish Color",
      "Material",
      "Style",
      "Product Type",
      "Short Description",
      "Brand",
      "Wood Type",
      "Headboard Type",
      "Number of Shelves",
    ]) {
      expect(neverInventColumn(norm(c))).toBe(false);
    }
  });
});
