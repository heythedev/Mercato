import { describe, expect, it } from "vitest";
import { neverInventColumn } from "@/lib/ai/match-dropdown";
import { normalizeKey } from "@/lib/export/zip";
import { defaultKey } from "@/lib/export/defaults";

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
