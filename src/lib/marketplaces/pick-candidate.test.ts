import { describe, it, expect } from "vitest";
import { pickWalmartCandidate } from "./verify";

type C = { name?: string; upc?: string };

describe("pickWalmartCandidate", () => {
  it("takes an exact barcode match even when it isn't ranked first", () => {
    const picked = pickWalmartCandidate(
      "Bon 11-482 Flat Slicker",
      "743153114827",
      [
        { name: "Bon 11-385 English Plugging Chisel", upc: "743153113859" },
        { name: "Bon 11-482 Flat Slicker - Double", upc: "743153114827" },
      ] as C[],
    );
    expect(picked?.name).toContain("Flat Slicker");
  });

  it("rejects a sibling SKU rather than accepting the top hit", () => {
    // The real failure: Walmart ranks a same-family, different-model item first.
    const picked = pickWalmartCandidate(
      "Bon 11-482 Flat Slicker - Double 1 4-inch X 3 8-inch",
      "743153114827",
      [{ name: "Bon 11-385 English Plugging Chisel - 1/4-inch X 10-inch", upc: "743153113859" }] as C[],
    );
    expect(picked).toBeNull();
  });

  it("rejects the mortar box size sibling", () => {
    const picked = pickWalmartCandidate(
      "Bon 11-303 Mortar Box - Steel 8.4 Cubic Feet",
      "743153113035",
      [{ name: "Bon Tool 11-304 Mortar Box - Steel 4.5 Cu Ft", upc: "743153113042" }] as C[],
    );
    expect(picked).toBeNull();
  });

  it("accepts a matching model code even when wording differs a lot", () => {
    const picked = pickWalmartCandidate(
      "Bon 11-174 Mortar Pan - Steel - 29-inch X 29-inch",
      null,
      [{ name: "Bon Tool 11-174 29 In. X 29 In. Steel Mortar Mixing Pan" }] as C[],
    );
    expect(picked?.name).toContain("11-174");
  });

  it("prefers the same-code candidate over a higher-ranked different one", () => {
    const picked = pickWalmartCandidate(
      "Bon 32-291 Detail Chisel - Aluminum 6-inch",
      null,
      [
        { name: "Bon Tool 32-297 Detail Chisel - Aluminum 3-inch" },
        { name: "Bon Tool 32-291 Detail Chisel Aluminum 6 In." },
      ] as C[],
    );
    expect(picked?.name).toContain("32-291");
  });

  it("rejects a candidate whose barcode contradicts ours, however similar the name", () => {
    // Same-family products with no model code in the title: word overlap cannot
    // separate them, but the published barcode can.
    const picked = pickWalmartCandidate(
      "Caroline's Treasures Japanese Chin in Sunflowers Throw Pillow",
      "198453051714",
      [{
        name: "Carolines Treasures 18 x 27 in. Japanese Chin in Sunflowers Pillow",
        upc: "198453350992",
      }] as C[],
    );
    expect(picked).toBeNull();
  });

  it("still accepts a same-name candidate when it publishes no barcode", () => {
    // No contradicting evidence — unverifiable, but not disproven.
    const picked = pickWalmartCandidate(
      "Caroline's Treasures Japanese Chin in Sunflowers Throw Pillow",
      "198453051714",
      [{ name: "Carolines Treasures Japanese Chin in Sunflowers Throw Pillow" }] as C[],
    );
    expect(picked).not.toBeNull();
  });

  it("returns null when nothing clears the similarity floor", () => {
    const picked = pickWalmartCandidate(
      "Widget Deluxe Titanium Edition",
      null,
      [{ name: "Garden Hose 50ft Green" }] as C[],
    );
    expect(picked).toBeNull();
  });

  it("returns null for an empty candidate list", () => {
    expect(pickWalmartCandidate("anything", "123", [])).toBeNull();
  });

  it("accepts a genuine match on wording alone when no codes are present", () => {
    const picked = pickWalmartCandidate(
      "Stainless Steel Mixing Bowl Set 5 Piece",
      null,
      [{ name: "Stainless Steel Mixing Bowl Set, 5 Piece Nesting Bowls" }] as C[],
    );
    expect(picked).not.toBeNull();
  });

  it("barcode match wins over a title-similarity rival", () => {
    const picked = pickWalmartCandidate(
      "Generic Blue Widget",
      "012345678905",
      [
        { name: "Generic Blue Widget Deluxe", upc: "999999999999" },
        { name: "Totally Different Name", upc: "012345678905" },
      ] as C[],
    );
    expect(picked?.name).toBe("Totally Different Name");
  });
});
