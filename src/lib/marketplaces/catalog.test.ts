import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_IDS,
  MARKETPLACE_IDS_WITH_VARIANTS,
  MARKETPLACE_TILES,
  marketplaceDomain,
  marketplaceLabel,
  toTileId,
} from "./catalog";

/**
 * The catalogue is meant to be the one list, and for a while it was not.
 *
 * Three screens each kept a copy. The admin Templates dropdown had seven ids
 * hardcoded, so from the day Wayfair shipped no Wayfair template could be
 * uploaded through it, and eBay was unavailable the day after it was added.
 * Neither broke anything that errored — the marketplace was simply not in the
 * list, which reads as "the deploy has not landed" and sends you looking in
 * the wrong place entirely.
 *
 * These tests are the guard, so the next marketplace cannot be half-added.
 */

describe("every marketplace is offered everywhere", () => {
  it("includes the ones that were missed", () => {
    expect(MARKETPLACE_IDS).toContain("wayfair");
    expect(MARKETPLACE_IDS).toContain("ebay");
  });

  it("offers every tile for a template, plus Amazon's stored variant", () => {
    for (const tile of MARKETPLACE_TILES) {
      expect(MARKETPLACE_IDS_WITH_VARIANTS, tile.id).toContain(tile.id);
    }
    // A project is tagged amazon_us, so a template has to be taggable that way
    // too or the two can never match.
    expect(MARKETPLACE_IDS_WITH_VARIANTS).toContain("amazon_us");
    expect(MARKETPLACE_IDS_WITH_VARIANTS.length).toBe(MARKETPLACE_TILES.length + 1);
  });

  it("names and draws every one of them", () => {
    for (const id of MARKETPLACE_IDS_WITH_VARIANTS) {
      // An unnamed marketplace renders as an empty cell, and an undrawn one
      // as a missing logo beside a row nobody can identify.
      expect(marketplaceLabel(id), id).toBeTruthy();
      expect(marketplaceLabel(id), id).not.toBe(id);
      expect(marketplaceDomain(id), id).toBeTruthy();
    }
  });
});

describe("naming a marketplace", () => {
  it("gives Amazon's variant a name of its own", () => {
    expect(marketplaceLabel("amazon_us")).toBe("Amazon US");
    expect(marketplaceLabel("amazon")).toBe("Amazon");
    // Both are the same tile for access control, and that has not changed.
    expect(toTileId("amazon_us")).toBe("amazon");
  });

  it("uses the tile's own label and domain", () => {
    expect(marketplaceLabel("bestbuy")).toBe("Best Buy");
    expect(marketplaceLabel("ebay")).toBe("eBay");
    expect(marketplaceDomain("ebay")).toBe("ebay.com");
    expect(marketplaceDomain("mathis")).toBe("mathishome.com");
  });

  it("tolerates the spellings a stored row actually carries", () => {
    expect(marketplaceLabel("EBAY")).toBe("eBay");
    expect(marketplaceLabel(" Walmart ")).toBe("Walmart");
  });

  it("falls back to the id rather than rendering nothing", () => {
    // A marketplace added to the database before it is added here still has
    // to show as something a person can read.
    expect(marketplaceLabel("etsy")).toBe("etsy");
    expect(marketplaceDomain("etsy")).toBeUndefined();
  });
});
