import { describe, expect, it } from "vitest";
import { referenceDataDropdowns } from "./zip";

/**
 * Option lists that a Best Buy workbook states on its ReferenceData sheet.
 *
 * Every fixture below is taken from the export the client sent back —
 * mercato-BestBuy-Project2-bestbuy-23-09-2026.xlsx, category Seasonal
 * Decorations. On that file 22 columns are REQUIRED and two of them, Occasion
 * and Indoor or Outdoor Use, came out empty on all 13 product rows, with their
 * allowed values sitting on a sheet in the same workbook the whole time.
 */

/** ReferenceData sheet, as it really is: one column per attribute, headed with
 *  the attribute's own field code. */
const REF = [
  { header: "categoryName", values: ["Home and Garden/Household Furnishings/Decor/Seasonal Decorations"] },
  { header: "Seasonal_Decorations.occasion", values: ["Any Occasion", "Christmas", "Easter", "Halloween"] },
  { header: "Seasonal_Decorations.indoorOrOutdoorUse", values: ["Indoor", "Outdoor", "Outdoor covered"] },
  { header: "Seasonal_Decorations.lighted", values: ["TRUE", "FALSE"] },
  { header: "Seasonal_Decorations.tradeItemHierarchy.each.dimensions.unitOfMeasure",
    values: ["Centimeters", "Feet", "Inches", "Meters", "Millimeters"] },
  { header: "Seasonal_Decorations.subjectToStateFlameRetardant", values: ["TRUE", "FALSE"] },
];

describe("ReferenceData option lists", () => {
  it("resolves a column by its own field code", () => {
    const got = referenceDataDropdowns(REF, [
      { letter: "AT", code: "Seasonal_Decorations.occasion" },
      { letter: "AU", code: "Seasonal_Decorations.indoorOrOutdoorUse" },
    ]);
    expect(got.get("AT")).toEqual(["Any Occasion", "Christmas", "Easter", "Halloween"]);
    expect(got.get("AU")).toEqual(["Indoor", "Outdoor", "Outdoor covered"]);
  });

  it("does NOT hand a column the list that its defined name points at", () => {
    // This is the whole reason the join is by name. In the real workbook the
    // validation attached to AT (Occasion) resolves to ReferenceData!$J$2:$J$3,
    // which is the `lighted` TRUE/FALSE list; the one on the Color column
    // resolves to subjectToStateFlameRetardant, also TRUE/FALSE. Following
    // those names would put "TRUE" in Occasion — a confident wrong value in a
    // REQUIRED cell, which is worse than the blank it replaces.
    const got = referenceDataDropdowns(REF, [{ letter: "AT", code: "Seasonal_Decorations.occasion" }]);
    expect(got.get("AT")).not.toContain("TRUE");
    expect(got.get("AT")).not.toContain("FALSE");
  });

  it("leaves a column alone when ReferenceData has no list for it", () => {
    // gtin, productName and the numeric dimension cells are free text on this
    // template and must stay that way — a dimension is not a choice.
    const got = referenceDataDropdowns(REF, [
      { letter: "D", code: "gtin" },
      { letter: "BJ", code: "Seasonal_Decorations.tradeItemHierarchy.each.dimensions.length" },
    ]);
    expect(got.size).toBe(0);
  });

  it("ignores a single-value column — that is a constant, not a choice", () => {
    // categoryName is one value repeated down the sheet. Treating it as a
    // dropdown adds nothing and invites a pointless AI question per row.
    const got = referenceDataDropdowns(REF, [{ letter: "A", code: "categoryName" }]);
    expect(got.has("A")).toBe(false);
  });

  it("refuses a data column masquerading as a list", () => {
    // The same sheet carries shopSku: 14,290 rows of product data, not options.
    const huge = [{ header: "shopSku", values: Array.from({ length: 14290 }, (_, i) => `SKU-${i}`) }];
    const got = referenceDataDropdowns(huge, [{ letter: "B", code: "shopSku" }]);
    expect(got.has("B")).toBe(false);
  });

  it("keeps a genuinely long list — brand has 398 entries and is real", () => {
    const brands = [{ header: "brand", values: Array.from({ length: 398 }, (_, i) => `Brand ${i}`) }];
    const got = referenceDataDropdowns(brands, [{ letter: "E", code: "brand" }]);
    expect(got.get("E")).toHaveLength(398);
  });

  it("falls back to the header or label when no field code is carried", () => {
    // Not every template exposes a row-2 code; the human header is the next
    // best key and normalizes to the same string.
    const got = referenceDataDropdowns(REF, [
      { letter: "AT", header: "Seasonal_Decorations.occasion" },
      { letter: "AU", label: "Seasonal_Decorations.indoorOrOutdoorUse" },
    ]);
    expect(got.get("AT")).toContain("Christmas");
    expect(got.get("AU")).toContain("Indoor");
  });

  it("de-duplicates repeated values", () => {
    const dup = [{ header: "x", values: ["Indoor", "Indoor", "Outdoor", " Outdoor ", ""] }];
    expect(referenceDataDropdowns(dup, [{ letter: "A", code: "x" }]).get("A")).toEqual(["Indoor", "Outdoor"]);
  });
});
