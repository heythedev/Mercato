import { describe, expect, it } from "vitest";
import { defaultFor, defaultKey, settingEnabled, isSettingKey, SETTING_KEYS, type ExportDefaults } from "./defaults";

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

describe("reserved settings", () => {
  it("reads the grey-cell switch only when explicitly on", () => {
    const on = defaults([["__fill_na_cells", "on"]]);
    const off = defaults([["__fill_na_cells", "off"]]);
    expect(settingEnabled(on, SETTING_KEYS.fillNaCells)).toBe(true);
    expect(settingEnabled(off, SETTING_KEYS.fillNaCells)).toBe(false);
    // Absent means off: the export must clear grey cells unless an admin has
    // decided otherwise, because a value there can have the row rejected.
    expect(settingEnabled(new Map(), SETTING_KEYS.fillNaCells)).toBe(false);
  });

  it("accepts the spellings an admin might store", () => {
    for (const v of ["on", "true", "YES", "1"]) {
      expect(settingEnabled(defaults([["__fill_na_cells", v]]), SETTING_KEYS.fillNaCells)).toBe(true);
    }
    for (const v of ["off", "false", "no", "0", ""]) {
      expect(settingEnabled(defaults([["__fill_na_cells", v]]), SETTING_KEYS.fillNaCells)).toBe(false);
    }
  });

  it("never lets a settings row answer a column", () => {
    // Both directions: the setting must not leak into a cell, and a column
    // named like the setting must not read it either.
    const d = defaults([["__fill_na_cells", "on"], ["material", "Cotton"]]);
    expect(defaultFor(d, "__fill_na_cells")).toBe("");
    expect(defaultFor(d, "material")).toBe("Cotton");
    expect(isSettingKey(defaultKey("__fill_na_cells"))).toBe(true);
    expect(isSettingKey(defaultKey("material"))).toBe(false);
  });
});
