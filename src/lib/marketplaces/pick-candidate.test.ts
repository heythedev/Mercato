import { describe, it, expect } from "vitest";
import type { Product } from "@prisma/client";
import { filterPackCompatible, listingQuality, pickBestCandidate, pickWalmartCandidate } from "./verify";

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

// EMRY-3060571: one UPC (024034668852), three listings — the canonical single,
// a "(Pkg of 3)", and a 12-case whose title is the bare distributor feed text
// with NO pack wording and whose provider row carried packageQuantity: null.
// With zero pack evidence the case pack reads as a single and its feed-copied
// title wins the similarity contest. Keepa's catalog attributes carry the real
// count (12); enrichCandidatePackData patches it in before the pack filter.
describe("pickBestCandidate — hidden case packs on a shared UPC", () => {
  const vendor = product({
    name: "FIXTURE JELLY JAR 1LT BL (Pack of 1)",
    brand: "WESTINGHOUSE LIGHTING",
  });
  const single = {
    asin: "B00002N5CR", title: "Westinghouse Angelo Brothers 66885 One-Light Jelly Jar, Black",
    brand: "Westinghouse", model: "6688500", salesRank: 516275, reviewCount: 87, offerCount: 4,
    packageQuantity: 1,
  };
  const threePack = {
    asin: "B00QSC2K0C", title: "Westinghouse Lighting 66885 One-Light Jelly Jar Fixture (Pkg of 3)",
    brand: "Westinghouse", partNumber: "66885", salesRank: 733000, reviewCount: 12, offerCount: 2,
    packageQuantity: 3,
  };
  // The trap, exactly as the provider returned it: feed-copied title, no
  // structured pack data.
  const hiddenTwelvePack = {
    asin: "B0044URDYI", title: "FIXTURE JELLY JAR 1LT BL",
    brand: "Westinghouse", partNumber: "6688500", salesRank: 412000, reviewCount: 31, offerCount: 3,
  };

  it("documents the trap: without enrichment the pack-wordless case pack wins", () => {
    // The feed-copied title scores ~1.0 similarity; the +10 confirmed-single
    // nudge is deliberately too small to save this. Enrichment is load-bearing.
    const picked = pickBestCandidate(vendor, [single, threePack, hiddenTwelvePack]);
    expect(picked.asin).toBe("B0044URDYI");
  });

  it("excludes the case pack once enrichment fills its Keepa pack count", () => {
    const enriched = { ...hiddenTwelvePack, packageQuantity: 12 };
    const survivors = filterPackCompatible(vendor.name, [single, threePack, enriched]);
    expect(survivors.map((c) => c.asin)).toEqual(["B00002N5CR"]);
    const picked = pickBestCandidate(vendor, [single, threePack, enriched]);
    expect(picked.asin).toBe("B00002N5CR");
  });

  it("breaks a dead-equal tie toward the provider-confirmed single", () => {
    // Identical listings except one PROVES packageQuantity 1 and the other
    // merely defaults to it. Unconfirmed listed first: strict-greater scoring
    // means the confirmed one must actually outscore it to win.
    const base = {
      title: "Westinghouse 66885 One-Light Jelly Jar, Black",
      brand: "Westinghouse", model: "6688500", salesRank: 516275, reviewCount: 87, offerCount: 4,
    };
    const unconfirmed = { ...base, asin: "UNCONFIRMED" };
    const confirmed = { ...base, asin: "CONFIRMED", packageQuantity: 1 };
    const picked = pickBestCandidate(
      product({ name: "FIXTURE JELLY JAR 1LT BL (Pack of 1)", brand: "WESTINGHOUSE LIGHTING" }),
      [unconfirmed, confirmed],
    );
    expect(picked.asin).toBe("CONFIRMED");
  });

  it("keeps the nudge below real quality signals so strong picks don't flip", () => {
    // A weak confirmed single (deep rank, 3 reviews, one seller) must not beat
    // the listing buyers actually use just because the latter lacks pack data.
    const base = { title: "Westinghouse 66885 One-Light Jelly Jar, Black", brand: "Westinghouse", model: "6688500" };
    const weakConfirmed = {
      ...base, asin: "WEAK", salesRank: 900000, reviewCount: 3, offerCount: 1, packageQuantity: 1,
    };
    const strongUnknown = {
      ...base, asin: "STRONG", salesRank: 5000, reviewCount: 2354, offerCount: 17,
    };
    const picked = pickBestCandidate(
      product({ name: "FIXTURE JELLY JAR 1LT BL (Pack of 1)", brand: "WESTINGHOUSE LIGHTING" }),
      [weakConfirmed, strongUnknown],
    );
    expect(picked.asin).toBe("STRONG");
  });
});

// Synccentric-primary pools carry NO price/rank/review data. When the Keepa
// quality backfill fails (token shortfall), the only enriched candidate is
// whatever the payload cache held — the PREVIOUS pick, whose price the
// re-uploaded vendor file echoes back. Price proximity must not fire on a
// one-priced-candidate pool, or the old wrong match re-locks itself forever.
describe("pickBestCandidate — quality-blind Synccentric pools", () => {
  it("does not re-lock a cached previous pick that is the only priced candidate", () => {
    // EMRY-1392331 as prod actually saw it (Synccentric rows from the live
    // probe, Keepa at −762 tokens): the stale duplicate was re-picked purely
    // on its unopposed price echo.
    const stale = {
      asin: "B002YCGOAW", title: "Black Jack 6460-9-20 10 Lb Black Jack Hole Patch Repair",
      brand: "Gardner-Gibson", partNumber: "6460-9-20", price: 3137,
      salesRank: 1381313, reviewCount: 3, offerCount: 1,
    };
    const drivePatch = {
      asin: "B07JF27HXQ", title: "Black Jack Drive-Patch Matte Black Water-Based Latex Driveway Sealer",
      brand: "Gardner-Gibson", model: "6460-9-20",
    };
    const speedPatch = {
      asin: "B001B175Y6", title: "Black Jack Speed-Patch Blacktop Crack & Hole Repair - 10 lbs., Ready-to-Use Asphalt Patching Compound",
      brand: "BLACK JACK", model: "6460-9-20",
    };
    const picked = pickBestCandidate(
      product({ name: "PATCH DRIVE TROWEL 10LB (Pack of 1)", brand: "GARDNER-GIBSON", price: 31.37 }),
      [stale, drivePatch, speedPatch],
    );
    expect(picked.asin).not.toBe("B002YCGOAW");
  });

  it("still uses price proximity when the pool has real prices to compare", () => {
    // Two priced candidates: the reseller-relist case must keep working.
    const fair = {
      asin: "FAIR", title: "Bonide Mosquito Beater Granules, 1.3 lbs",
      brand: "Bonide", price: 1199, salesRank: 4640, reviewCount: 2354, offerCount: 17,
    };
    const gouged = {
      asin: "GOUGED", title: "Bonide Mosquito Beater Granules, 1.3 lbs",
      brand: "Bonide", price: 6067, salesRank: 113762, reviewCount: 35, offerCount: 13,
    };
    const picked = pickBestCandidate(
      product({ name: "MOSQUITO BEATER GRANUL (Pack of 1)", brand: "BONIDE", price: 11.99 }),
      [gouged, fair],
    );
    expect(picked.asin).toBe("FAIR");
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
