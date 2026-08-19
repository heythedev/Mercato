import { describe, it, expect } from "vitest";
import { extractPackInfo, extractPackQty } from "./verify";

describe("extractPackInfo", () => {
  it("treats explicit packaging terms as strong signals", () => {
    expect(extractPackInfo("Kitchen Towels Pack of 6")).toEqual({ qty: 6, strong: true, explicit: true });
    expect(extractPackInfo("Coasters Set of 4")).toEqual({ qty: 4, strong: true, explicit: true });
    expect(extractPackInfo("Trivets 12 ct")).toEqual({ qty: 12, strong: true, explicit: true });
    expect(extractPackInfo("Wholesale CASE of 10 Pot Holders")).toEqual({ qty: 10, strong: true, explicit: true });
  });

  it("treats counting words as weak signals", () => {
    // "3-Piece Sectional Sofa" is one sofa in three modules, not a 3-pack —
    // this was the client's main pack false-positive.
    expect(extractPackInfo("3-Piece Sectional Sofa")).toEqual({ qty: 3, strong: false, explicit: true });
    expect(extractPackInfo("Widget 6 units")).toEqual({ qty: 6, strong: false, explicit: true });
  });

  it("no longer reads a product-type word 'case' as a quantity", () => {
    // "iPhone 15 Case" used to extract qty 15.
    expect(extractPackInfo("iPhone 15 Case")).toEqual({ qty: 1, strong: false, explicit: false });
  });

  it("lets a strong description signal beat a weak title signal", () => {
    expect(extractPackInfo("3-Piece Towel Bundle", "Sold as a pack of 2 bundles"))
      .toEqual({ qty: 2, strong: true, explicit: true });
  });

  it("defaults to a single unit when nothing is stated", () => {
    expect(extractPackInfo("Ceramic Mug")).toEqual({ qty: 1, strong: false, explicit: false });
  });
});

describe("extractPackQty", () => {
  it("keeps the plain-number contract for candidate filtering", () => {
    expect(extractPackQty("Kitchen Towels Pack of 6")).toBe(6);
    expect(extractPackQty("3-Piece Sectional Sofa")).toBe(3);
    expect(extractPackQty("Ceramic Mug")).toBe(1);
  });
});
