import { describe, expect, it } from "vitest";
import { categoryIndex, categoryPathsFor, INLINE_TAXONOMY_MAX, nextSegments } from "@/lib/categorize/taxonomy";
import { isConstrainedMarketplace, taxonomyFor } from "./taxonomy-registry";
import { profileFor } from "./profile";
import { MARKETPLACE_IDS } from "./catalog";
import { skipsVerification } from "@/lib/projects/marketplace-flow";
import { clearEbayCache, ebayCategoryIdForPath, loadEbayCategories } from "@/lib/ai/ebay-taxonomy";

// eBay is the first marketplace whose category list does not fit in a prompt,
// and the first that is a flat CSV with no template describing its columns.
// Both facts are load-bearing, so both are pinned here.

describe("eBay is a marketplace Mercato knows about", () => {
  it("is offered, and has no verification step", () => {
    expect(MARKETPLACE_IDS).toContain("ebay");
    // There is no eBay listing to compare a product against, so the flow goes
    // upload → categorise → export with nothing in between.
    expect(skipsVerification("ebay")).toBe(true);
  });

  it("looks missing attributes up in the catalogue", () => {
    // eBay asks for Colour, Size and Style per product and this vendor's
    // sheets carry Material and little else, so those columns shipped empty
    // with nothing wrong anywhere — the wiring worked, there was nothing to
    // read. Synccentric returns colour and size in the same response as the
    // dimensions, so the answer was already being fetched for Mathis and
    // Best Buy and discarded here.
    expect(profileFor("ebay").enrichesFromCatalog).toBe(true);
    expect(profileFor("mathis").enrichesFromCatalog).toBe(true);
    expect(profileFor("bestbuy").enrichesFromCatalog).toBe(true);
  });

  it("does not turn catalogue lookups on for a marketplace nobody has declared", () => {
    // Every lookup costs a Synccentric search against a daily quota, so this
    // is one trait where the conservative default is about money as well as
    // correctness.
    expect(profileFor("etsy").enrichesFromCatalog).toBe(false);
    expect(profileFor("walmart").enrichesFromCatalog).toBe(false);
  });

  it("claims no template capability it has not demonstrated", () => {
    const p = profileFor("ebay");
    // A flat CSV: no "Columns" sheet, no per-category matrix, no scoped codes.
    expect(p.requirementMatrix).toBe(false);
    expect(p.categoryScopedColumnCodes).toBe(false);
    expect(p.excludesOfferColumns).toBe(false);
  });
});

describe("its category list", () => {
  it("is read with ids intact — eBay's upload wants the id, not the path", () => {
    const rows = loadEbayCategories();
    expect(rows.length).toBe(18095);
    // Every row carries one. A path is enough to CHOOSE a category with and
    // not enough to UPLOAD one with, so an id-less row would surface as a
    // rejected file after everything else was already right.
    expect(rows.filter((r) => r.id).length).toBe(rows.length);
  });

  it("answers from a cold cache, which is every cold start in production", () => {
    // The id lookup used to assign its map and THEN load, and loading clears
    // every cache on a miss — so the map was nulled underneath the loop that
    // was filling it and the next write threw. Every test that ran after
    // something else had already warmed the cache passed.
    clearEbayCache();
    expect(ebayCategoryIdForPath("Antiques > Architectural & Garden > Beams")).toBe("162927");
  });

  it("keeps a path whose own name contains a comma", () => {
    // Quoted in the CSV: "Antiques > ... > Chandeliers, Sconces & Lighting
    // Fixtures". Split on commas and this becomes two categories, neither
    // real — the same class of mistake as the vendor CSV line-break bug.
    const path = "Antiques > Architectural & Garden > Chandeliers, Sconces & Lighting Fixtures";
    expect(categoryPathsFor("ebay")).toContain(path);
    expect(ebayCategoryIdForPath(path)).toBe("63516");
  });

  it("is a closed set, so a composed category can be refused", () => {
    // Without this entry the MCP write tool answers "No category list for
    // ebay" and nothing can be categorised through Claude at all.
    expect(categoryIndex("ebay")).not.toBeNull();
    expect(isConstrainedMarketplace("ebay")).toBe(true);
  });
});

describe("being too large to send whole", () => {
  it("is well past the inline ceiling", () => {
    expect(categoryPathsFor("ebay")!.length).toBeGreaterThan(INLINE_TAXONOMY_MAX * 10);
  });

  it("narrows to a real branch one level at a time", () => {
    const index = categoryIndex("ebay")!;
    const top = nextSegments(index.paths);
    expect(top.length).toBe(36);
    for (const t of top) {
      expect(index.paths.some((p) => p === t || p.startsWith(`${t} > `)), t).toBe(true);
    }
    const inAntiques = nextSegments(index.paths, "Antiques");
    expect(inAntiques.length).toBeGreaterThan(0);
    expect(inAntiques.length).toBeLessThan(top.length + index.paths.length);
    for (const t of inAntiques) expect(t.startsWith("Antiques > ")).toBe(true);
  });

  it("refuses in-app categorisation with a reason, rather than failing at the provider", () => {
    const reason = taxonomyFor("ebay")!.unavailableReason!();
    expect(reason).toMatch(/18,095 categories/);
    // The refusal has to name the route that does work, or it reads as
    // "eBay is broken" rather than "use Claude for this one".
    expect(reason).toMatch(/Claude/);
  });
});
