import { describe, expect, it } from "vitest";
import { defaultFor, defaultKey, type ExportDefaults } from "./defaults";

const defaults = (pairs: [string, string][]): ExportDefaults =>
  new Map(pairs.map(([k, v]) => [defaultKey(k), v]));

describe("export defaults", () => {
  it("answers a column by its attribute code", () => {
    const d = defaults([["californiaProposition65Warning.type", "No warning applicable"]]);
    expect(defaultFor(d, "californiaProposition65Warning.type")).toBe("No warning applicable");
  });

  it("answers the same column when the template prefixes it with a category", () => {
    // Best Buy scopes codes per category, so one entry has to cover all 1,450
    // spellings of the same attribute.
    const d = defaults([["californiaProposition65Warning.type", "No warning applicable"]]);
    expect(defaultFor(d, "Wall_Art.californiaProposition65Warning.type")).toBe("No warning applicable");
    expect(defaultFor(d, "Dual_Fuel_Ranges.californiaProposition65Warning.type")).toBe("No warning applicable");
  });

  it("answers by human label too, since templates key on either", () => {
    const d = defaults([["California Proposition 65 Warning: Type", "No warning applicable"]]);
    // Label as stored, and the same label as the sheet's header row spells it.
    expect(defaultFor(d, "unmatched-code", "California Proposition 65 Warning: Type")).toBe(
      "No warning applicable",
    );
  });

  it("returns empty when nothing is set, so the cell falls through to the report", () => {
    expect(defaultFor(new Map(), "anything")).toBe("");
    expect(defaultFor(defaults([["containsIntentionallyAddedPfas", "No"]]), "someOtherColumn")).toBe("");
  });

  it("does not let one attribute answer for a different one", () => {
    // "type" alone is a suffix of the Prop 65 code; a bare column named "type"
    // in some other category must NOT inherit that value.
    const d = defaults([["californiaProposition65Warning.type", "No warning applicable"]]);
    expect(defaultFor(d, "Jackets.jacketStyle")).toBe("");
  });

  it("normalises punctuation and case, so an admin need not match the template exactly", () => {
    const d = defaults([["Contains intentionally added PFAS", "No"]]);
    expect(defaultFor(d, "containsIntentionallyAddedPfas")).toBe("No");
    expect(defaultFor(d, "CONTAINS_INTENTIONALLY_ADDED_PFAS")).toBe("No");
  });
});
