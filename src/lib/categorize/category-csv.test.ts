import { describe, expect, it } from "vitest";
import { parseCategoryCsv } from "./category-csv";

describe("parseCategoryCsv", () => {
  it("new Walmart format: joins Category + Group, captures the real Product Type", () => {
    const csv = [
      '"SKU","Product Name","Brand","Category","Product Type Group","Product Type","Category Path","Confidence","Status"',
      '"WM-1","Modern Table Lamp","Acme","Home","Lamps & Lighting","Table Lamps","Home > Lamps & Lighting","High","Done"',
    ].join("\n");
    const { rows, hasGroupColumn } = parseCategoryCsv(csv);
    expect(hasGroupColumn).toBe(true);
    expect(rows).toEqual([{
      sku: "WM-1",
      name: "Modern Table Lamp",
      category: "Home > Lamps & Lighting",
      path: "Home > Lamps & Lighting",
      specProductType: "Table Lamps",
    }]);
  });

  it("old format: 'Product Type' is the level-2 group, never a spec type", () => {
    const csv = [
      '"SKU","Product Name","Brand","Category","Product Type","Category Path","Confidence","Status"',
      '"WM-1","Modern Table Lamp","Acme","Home","Lamps & Lighting","Home > Lamps & Lighting","High","Done"',
    ].join("\n");
    const { rows, hasGroupColumn } = parseCategoryCsv(csv);
    expect(hasGroupColumn).toBe(false);
    expect(rows[0]!.category).toBe("Home > Lamps & Lighting");
    expect(rows[0]!.specProductType).toBeNull();
  });

  it("quoted commas survive (categories and names contain them)", () => {
    const csv = [
      '"SKU","Product Name","Category","Product Type Group","Product Type"',
      '"S1","Bowl, Large, Blue","Home Decor, Kitchen, & Other","Dining","Serving Bowls"',
    ].join("\n");
    const { rows } = parseCategoryCsv(csv);
    expect(rows[0]!.name).toBe("Bowl, Large, Blue");
    expect(rows[0]!.category).toBe("Home Decor, Kitchen, & Other > Dining");
    expect(rows[0]!.specProductType).toBe("Serving Bowls");
  });

  it("handles tab-delimited files and a BOM", () => {
    const csv = "﻿SKU\tProduct Name\tCategory\tProduct Type\nS1\tLamp\tHome\tLighting";
    const { rows } = parseCategoryCsv(csv);
    expect(rows[0]!.category).toBe("Home > Lighting");
  });

  it("a category cell already carrying a full path is never re-joined", () => {
    const csv = [
      '"SKU","Product Name","Category","Product Type Group","Product Type"',
      '"S1","Lamp","Home > Lamps & Lighting","Lamps & Lighting","Table Lamps"',
    ].join("\n");
    const { rows } = parseCategoryCsv(csv);
    expect(rows[0]!.category).toBe("Home > Lamps & Lighting");
  });

  it("errors without a Category column", () => {
    expect(parseCategoryCsv('"SKU","Name"\n"a","b"').error).toBeTruthy();
  });
});
