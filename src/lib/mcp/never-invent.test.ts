import { describe, expect, it } from "vitest";
import { neverInventColumn } from "@/lib/ai/match-dropdown";
import { normalizeKey } from "@/lib/export/zip";
import { defaultKey } from "@/lib/export/defaults";
import { columnsAnsweredByProduct } from "./tools";

/**
 * The columns no model may answer, checked the way the MCP door checks them.
 *
 * The export refuses to let a model near these, then reads ProductAttribute
 * and writes whatever it finds into the file. submit_export_values wrote into
 * that same table with no such guard — so a value arriving through MCP reached
 * the exact cell the guard existed to keep a model out of. A guessed
 * Proposition 65 answer is a false legal statement published under the
 * client's name whichever model guessed it, and "it was Claude, not Kimi" is
 * not a defence.
 *
 * This pins the composition both doors now use, for the columns that matter.
 */
const barred = (column: string) =>
  neverInventColumn(normalizeKey(column)) || neverInventColumn(defaultKey(column));

describe("columns barred from every model", () => {
  it.each([
    "California Proposition 65 Warning",
    "californiaProposition65Warning.type",
    "PFAS Declaration",
    "Contains Embedded Battery",
    "Lithium Battery Type",
    "UPC",
    "GTIN / EAN",
    "Product Length (in)",
    "Product Weight (lbs)",
    "DIMH",
    "Main Image URL",
  ])("refuses %s", (column) => {
    expect(barred(column)).toBe(true);
  });

  it.each(["Material", "Style", "Finish Color", "Wood Type", "Pattern", "Shape"])(
    "still allows %s, which a product's own description can answer",
    (column) => {
      expect(barred(column)).toBe(false);
    },
  );
});

/**
 * And the columns nobody should be ASKED for, because the product already
 * answers them.
 *
 * Seeding the gap list from the requirement matrix made the tool work before
 * an export existed, and in the same move put Name, Brand, Category and Offer
 * Price back on the list — columns the export fills from the product row and
 * the vendor sheet without consulting anything. A model asked for the name of
 * a product it can see the name of will write one.
 */
describe("columns the product's own record answers", () => {
  const product = {
    name: "Ashley Larkinhurst Sofa",
    brand: "Ashley",
    description: "A faux-leather sofa.",
    marketplaceCategory: "Mathis Home/Furniture/Sofas",
    price: 799.99,
    vendorData: { "Assembly Required": "Yes", "Finish Color": "", Width: "89" },
  };

  const answered = (column: string) => columnsAnsweredByProduct(product).has(normalizeKey(column));

  it.each(["Name", "Product Name", "Brand", "Category", "Short Description", "Offer Price"])(
    "does not ask for %s",
    (column) => expect(answered(column)).toBe(true),
  );

  it("counts a column the vendor sheet filled", () => {
    expect(answered("Assembly Required")).toBe(true);
  });

  it("still asks when the vendor sheet left the column blank", () => {
    expect(answered("Finish Color")).toBe(false);
  });

  it.each(["Material", "Style", "Wood Type"])("still asks for %s", (column) =>
    expect(answered(column)).toBe(false),
  );

  it("asks for everything when the product carries nothing", () => {
    const bare = { name: "", brand: null, description: null, marketplaceCategory: null, price: null, vendorData: null };
    expect(columnsAnsweredByProduct(bare).size).toBe(0);
  });
});
