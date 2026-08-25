import { describe, it, expect } from "vitest";
import type { Product } from "@prisma/client";
import { listingQuality, pickBestCandidate, pickWalmartCandidate } from "./verify";

type C = { name?: string; upc?: string };

const product = (p: Record<string, unknown>): Product =>
  ({ id: "t", brand: null, price: null, vendorData: {}, ...p }) as unknown as Product;

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

// Amazon carries duplicate listings of one physical product under a shared
// UPC: the canonical listing plus reseller relists whose titles copy the
// distributor feed — i.e. our own vendor text. These cases are the client's
// real EMRY rows (values from live Keepa pools) where the junk duplicate used
// to win on title similarity.
describe("pickBestCandidate — duplicate same-UPC listings", () => {
  it("prefers the canonical listing over a price-gouged relist with a feed-copied title", () => {
    // EMRY-7196496: vendor price echoes the OLD bad match ($60.67), the worst
    // case — price proximity alone would lock the relist in forever.
    const canonical = {
      asin: "B000UJTBWE", title: "Bonide Mosquito Beater Granules, 1.3 lbs Ready-to-Use",
      brand: "Bonide", model: "5612", price: 1199, salesRank: 4640, reviewCount: 2354, offerCount: 17,
    };
    const relist = {
      asin: "B00Y4YTL6W", title: "Mosquito Beater Area Repellent Granules4",
      brand: "Bonide", model: "5612", price: 6067, salesRank: 113762, reviewCount: 35, offerCount: 13,
    };
    const picked = pickBestCandidate(
      product({ name: "MOSQUITO REPEL GRANUL 4K (Pack of 1)", brand: "BONIDE PRODUCT", price: 60.67 }),
      [relist, canonical],
    );
    expect(picked.asin).toBe("B000UJTBWE");
  });

  it("never picks a '(Discontinued)' duplicate over the live canonical listing", () => {
    // EMRY-1409085: the discontinued copy's title matches the vendor
    // abbreviation almost verbatim; the canonical title doesn't even say 12 Oz.
    const canonical = {
      asin: "B001ESTA30", title: "Howard Products Butcher Block Conditioner and Food Grade Mineral Oil for Wood Cutting Boards",
      brand: "Howard Products", model: "BBC012", price: 998, salesRank: 4911, reviewCount: 9454, offerCount: 11,
    };
    const discontinued = {
      asin: "B00QU72NZ2", title: "Howard Products BBC012 12 Oz Butcher Block Conditioner (Discontinued)",
      brand: "Howard Products", partNumber: "BBC012", price: 999, salesRank: 297643, reviewCount: 606, offerCount: 10,
    };
    const picked = pickBestCandidate(
      product({ name: "BUTCHER BLOCK COND 12OZ (Pack of 1)", brand: "HOWARD PRODUCTS INC", price: 9.99 }),
      [discontinued, canonical],
    );
    expect(picked.asin).toBe("B001ESTA30");
  });

  it("prefers an actively sold duplicate over a stale single-offer one", () => {
    // EMRY-1392331: same brand, same product — the stale copy has 3 reviews and
    // one seller, but its title happens to contain a vendor token ("Patch").
    const active = {
      asin: "B0044FZD0O", title: "Gardner-Gibson 1665771 Black Jack Blacktop Crack and Hole Repair Latex Smooth Finish Black 10 L",
      brand: "Gardner-Gibson", model: "6460-9-20", price: 2882, salesRank: 622608, reviewCount: 51, offerCount: 6,
    };
    const stale = {
      asin: "B002YCGOAW", title: "Black Jack 6460-9-20 10 Lb Black Jack Hole Patch Repair",
      brand: "Gardner-Gibson", partNumber: "6460-9-20", price: 3137, salesRank: 1381313, reviewCount: 3, offerCount: 1,
    };
    const picked = pickBestCandidate(
      product({ name: "PATCH DRIVE TROWEL 10LB (Pack of 1)", brand: "GARDNER-GIBSON", price: 31.37 }),
      [stale, active],
    );
    expect(picked.asin).toBe("B0044FZD0O");
  });

  it("keeps pack compatibility dominant over any quality edge", () => {
    // A top-ranked multipack must never beat a correct single, however junk
    // the single looks.
    const multipack = {
      asin: "MULTI", title: "Howard BBC012 12 Oz Butcher Block Conditioner (4 Pack)",
      brand: "Howard Products", model: "BBC012", price: 3097, salesRank: 57821, reviewCount: 9454, offerCount: 12,
      packageQuantity: 4,
    };
    const single = {
      asin: "SINGLE", title: "Howard Products BBC012 12 Oz Butcher Block Conditioner (Discontinued)",
      brand: "Howard Products", model: "BBC012", price: 999, salesRank: 297643, reviewCount: 606, offerCount: 1,
    };
    const picked = pickBestCandidate(
      product({ name: "BUTCHER BLOCK COND 12OZ (Pack of 1)", brand: "HOWARD PRODUCTS INC", price: 9.99 }),
      [multipack, single],
    );
    expect(picked.asin).toBe("SINGLE");
  });
});

describe("listingQuality", () => {
  it("grades rank and reviews logarithmically", () => {
    const top = listingQuality({ salesRank: 5_000, reviewCount: 1_000 });
    const mid = listingQuality({ salesRank: 100_000, reviewCount: 50 });
    const none = listingQuality({});
    expect(top).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(none);
    expect(none).toBe(0);
  });

  it("penalizes discontinued titles and single-offer listings", () => {
    const base = { salesRank: 10_000, reviewCount: 100 };
    expect(listingQuality({ ...base, title: "Widget (Discontinued)" }))
      .toBeLessThan(listingQuality({ ...base, title: "Widget" }));
    expect(listingQuality({ ...base, offerCount: 1 }))
      .toBeLessThan(listingQuality({ ...base, offerCount: 8 }));
  });

  it("does not penalize missing offer data", () => {
    expect(listingQuality({ salesRank: 10_000 }))
      .toBe(listingQuality({ salesRank: 10_000, offerCount: 2 }));
  });
});
