import { describe, expect, it } from "vitest";
import { toDecimalDimension } from "./dimensions";

// The exact shapes the Vickerman catalog scrape stores into vendorData — the
// client's Mirakl import rejects any of them unless reduced to a bare decimal.
describe("toDecimalDimension", () => {
  it("strips inch marks", () => {
    expect(toDecimalDimension('18"')).toBe("18");
    expect(toDecimalDimension('4.7"')).toBe("4.7");
    expect(toDecimalDimension('0.5"')).toBe("0.5");
  });

  it("strips spelled-out inch units", () => {
    expect(toDecimalDimension("18 in.")).toBe("18");
    expect(toDecimalDimension("18in")).toBe("18");
    expect(toDecimalDimension("18 inches")).toBe("18");
  });

  it("converts feet to inches", () => {
    expect(toDecimalDimension("7.5'")).toBe("90");
    expect(toDecimalDimension("7.5 ft")).toBe("90");
    expect(toDecimalDimension("6 feet")).toBe("72");
  });

  it("converts compound feet + inches", () => {
    expect(toDecimalDimension("5' 6\"")).toBe("66");
    expect(toDecimalDimension("5 ft 6 in")).toBe("66");
  });

  it("passes bare decimals through unchanged", () => {
    expect(toDecimalDimension("18")).toBe("18");
    expect(toDecimalDimension("4.7")).toBe("4.7");
  });

  it("falls back to the leading number of a messy value", () => {
    expect(toDecimalDimension("18 in. approx")).toBe("18");
  });

  it("returns empty for blanks and non-numeric values", () => {
    expect(toDecimalDimension("")).toBe("");
    expect(toDecimalDimension("   ")).toBe("");
    expect(toDecimalDimension("N/A")).toBe("");
    expect(toDecimalDimension(null)).toBe("");
    expect(toDecimalDimension(undefined)).toBe("");
  });
});
