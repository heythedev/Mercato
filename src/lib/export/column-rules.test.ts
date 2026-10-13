import { describe, expect, it } from "vitest";
import {
  applyColumnRules,
  EMPTY_RULES,
  isProtectedColumn,
  type ColumnRule,
  type ColumnRuleSet,
} from "./column-rules";

/**
 * These run on every cell of every file, so the whole behaviour is asserted
 * here rather than inferred from a reading of the code.
 */

const rule = (r: Partial<ColumnRule>): ColumnRule => ({
  id: r.id ?? "r1",
  marketplace: "ebay",
  teamId: null,
  column: r.column ?? "productdescription",
  action: r.action ?? "replace",
  find: r.find ?? null,
  value: r.value ?? null,
  note: null,
  enabled: true,
});

const set = (...rules: ColumnRule[]): ColumnRuleSet => ({ rules, empty: rules.length === 0 });

describe("doing nothing", () => {
  it("returns the value untouched when there are no rules", () => {
    expect(applyColumnRules(EMPTY_RULES, "Title", "72 Red Deluxe")).toBe("72 Red Deluxe");
  });

  it("ignores a rule for a different column", () => {
    const s = set(rule({ column: "title", find: "Red", value: "Crimson" }));
    expect(applyColumnRules(s, "Product Description", "A Red garland")).toBe("A Red garland");
  });

  it("matches a column however its label is spelled", () => {
    // The admin types "Product Description"; the template header might be
    // "product_description". Both normalise to the same key.
    const s = set(rule({ column: "productdescription", find: "Red", value: "Crimson" }));
    expect(applyColumnRules(s, "product_description", "A Red garland")).toBe("A Crimson garland");
  });
});

describe("removing a word, for ever", () => {
  const s = set(rule({ find: "Garland", value: "" }));

  it("takes it out and closes the gap", () => {
    expect(applyColumnRules(s, "Product Description", "A Garland for the door")).toBe("A for the door");
  });

  it("ignores case", () => {
    expect(applyColumnRules(s, "Product Description", "A GARLAND here")).toBe("A here");
  });

  it("matches whole words only", () => {
    // Without the boundary "gap" matches "gaps", and a rule nobody can
    // predict is a rule somebody switches off.
    const gaps = set(rule({ find: "gap", value: "" }));
    expect(applyColumnRules(gaps, "Product Description", "Close the gaps evenly")).toBe("Close the gaps evenly");
    expect(applyColumnRules(gaps, "Product Description", "Leave a gap here")).toBe("Leave a here");
  });

  it("does not leave a space before punctuation", () => {
    expect(applyColumnRules(s, "Product Description", "Hang the Garland.")).toBe("Hang the.");
  });
});

describe("replacing a word with another", () => {
  it("swaps it and keeps the sentence readable", () => {
    // Deleting "ensure" left "This durable is maintenance free" 154 times in
    // one file. A replacement is what makes the sentence survive.
    const s = set(rule({ find: "ensure", value: "make sure" }));
    expect(applyColumnRules(s, "Product Description", "Wired edges ensure the shape holds")).toBe(
      "Wired edges make sure the shape holds",
    );
  });
});

describe("appending text", () => {
  const s = set(rule({ action: "append", value: "Returns accepted within 30 days." }));

  it("adds it to the end", () => {
    expect(applyColumnRules(s, "Product Description", "A pine garland.")).toBe(
      "A pine garland. Returns accepted within 30 days.",
    );
  });

  it("does not stack it on a re-export", () => {
    // The same file exported twice must not grow two copies of the sentence.
    const once = applyColumnRules(s, "Product Description", "A pine garland.");
    expect(applyColumnRules(s, "Product Description", once)).toBe(once);
  });

  it("leaves an empty cell empty", () => {
    // Appending to a blank makes an unanswered column look answered.
    expect(applyColumnRules(s, "Product Description", "")).toBe("");
    expect(applyColumnRules(s, "Product Description", "   ")).toBe("");
  });
});

describe("blanking a column", () => {
  it("empties it whatever was there", () => {
    const s = set(rule({ column: "variationgroupid", action: "blank" }));
    expect(applyColumnRules(s, "Variation Group ID", "734205765975")).toBe("");
  });
});

describe("the columns a rule may never touch", () => {
  it("protects every identifier", () => {
    for (const c of ["UPC", "EAN", "ISBN", "GTIN", "ASIN", "SKU", "MPN", "Barcode"]) {
      expect(isProtectedColumn(c), c).toBe(true);
    }
    expect(isProtectedColumn("Product Description")).toBe(false);
  });

  it("refuses even when a rule names one directly", () => {
    // A find-and-replace loose on a barcode is not a formatting preference;
    // it is a different product, and it still looks like a barcode in the
    // file. So the rule is refused at the point of use as well as at the
    // point of saving.
    const s = set(rule({ column: "upc", action: "blank" }));
    expect(applyColumnRules(s, "UPC", "734205765975")).toBe("734205765975");
  });
});

describe("a rule on every column", () => {
  const s = set(rule({ column: "*", find: "Garland", value: "wreath" }));

  it("reaches any text column", () => {
    expect(applyColumnRules(s, "Title", "Red Garland")).toBe("Red wreath");
    expect(applyColumnRules(s, "Product Description", "A Garland.")).toBe("A wreath.");
  });

  it("leaves a cell with no letters in it alone", () => {
    // A measurement or a price is not text somebody meant to reword.
    expect(applyColumnRules(s, "List Price", "55.15")).toBe("55.15");
  });
});

describe("two rules on one column", () => {
  it("compose in the order they were written", () => {
    const s = set(
      rule({ id: "a", find: "Garland", value: "wreath" }),
      rule({ id: "b", action: "append", value: "Indoor use only." }),
    );
    expect(applyColumnRules(s, "Product Description", "A Garland.")).toBe("A wreath. Indoor use only.");
  });
});
