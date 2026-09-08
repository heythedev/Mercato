import { describe, expect, it, vi } from "vitest";

// resolve-sku pulls the whole vendor-catalog chain (vickerman → keepa/walmart
// clients); the pure helpers under test need none of it.
vi.mock("./vendor-catalog", () => ({
  resolveSkuFromCatalog: vi.fn(async () => null),
  hasCatalogVendor: vi.fn(() => false),
}));

// Cross-project SKU reuse is a DB lookup; stub it so enrichSkuOnlyProducts
// never touches prisma here. Tests that want a hit queue one with
// mockResolvedValueOnce; the default finds nothing.
vi.mock("@/lib/categorize/category-reuse", () => ({
  findResolvedNamesBySku: vi.fn(async () => new Map()),
  normalizeSku: (s: string) => s.trim().toLowerCase(),
  // No prefix resolves to a brand by default, so the Keepa part-number step
  // stays switched off unless a test opts into it.
  findBrandsBySkuPrefix: vi.fn(async () => new Map()),
}));

import { findResolvedNamesBySku } from "@/lib/categorize/category-reuse";
import { resolveSkuFromCatalog } from "./vendor-catalog";
import {
  enrichSkuOnlyProducts,
  hitsReferenceSku,
  isUnresolvedSkuOnly,
  pickProductName,
  skuSearchVariants,
} from "./resolve-sku";

describe("enrichSkuOnlyProducts — cross-project SKU reuse", () => {
  const bare = { id: "p1", name: "VIDA-134814", sku: "VIDA-134814", brand: null, description: null };

  it("fills a bare-SKU row from another project's record of the same SKU, before any catalog call", async () => {
    // The real case: a Walmart upload of the same vidaXL catalog carried the full record.
    vi.mocked(findResolvedNamesBySku).mockResolvedValueOnce(
      new Map([[
        "vida-134814",
        {
          name: 'vidaXL Blackout Curtains with Rings 2 pcs Anthracite 54"x84" Velvet',
          brand: "vidaXL",
          description: "These elegant blackout curtains block almost 85% of incoming light.",
          upc: "8720286039632",
          imageUrl: "https://image.virventures.com/VIDA/134814.jpg",
        },
      ]]),
    );
    const { products, enrichments } = await enrichSkuOnlyProducts([bare], undefined, { excludeProjectId: "proj-x" });

    expect(vi.mocked(findResolvedNamesBySku)).toHaveBeenCalledWith("proj-x", ["VIDA-134814"]);
    expect(products[0]!.name).toBe('vidaXL Blackout Curtains with Rings 2 pcs Anthracite 54"x84" Velvet');
    expect(products[0]!.brand).toBe("vidaXL");
    expect(enrichments).toHaveLength(1);
    expect(enrichments[0]).toMatchObject({
      productId: "p1",
      upc: "8720286039632",
      imageUrl: "https://image.virventures.com/VIDA/134814.jpg",
    });
    // Found for free — the vendor-catalog network path was never needed.
    expect(vi.mocked(resolveSkuFromCatalog)).not.toHaveBeenCalled();
  });

  it("never trusts a cross-project name that is itself still a raw code", async () => {
    vi.mocked(findResolvedNamesBySku).mockResolvedValueOnce(
      new Map([["vida-134814", { name: "VIDA134814", brand: null, description: null, upc: null, imageUrl: null }]]),
    );
    const { products, enrichments } = await enrichSkuOnlyProducts([bare], undefined, { excludeProjectId: "proj-x" });
    expect(products[0]!.name).toBe("VIDA-134814");
    expect(enrichments).toHaveLength(0);
  });

  it("leaves the row untouched when no project anywhere knows the SKU", async () => {
    const { products, enrichments } = await enrichSkuOnlyProducts([bare], undefined, { excludeProjectId: "proj-x" });
    expect(products[0]).toEqual(bare);
    expect(enrichments).toHaveLength(0);
  });
});

describe("isUnresolvedSkuOnly", () => {
  it("is true for a bare SKU code with no description or vendor category", () => {
    // VIDA-110112 — a real example: name and sku both the same opaque code,
    // nothing else in the row to identify the product by.
    expect(isUnresolvedSkuOnly({ name: "VIDA-110112", sku: "VIDA-110112" })).toBe(true);
  });

  it("is false once a description is present, even with a SKU-shaped name", () => {
    expect(
      isUnresolvedSkuOnly({ name: "VIDA-110112", sku: "VIDA-110112", description: "12-inch ceramic planter" }),
    ).toBe(false);
  });

  it("is false once a vendor category is present, even with a SKU-shaped name", () => {
    expect(isUnresolvedSkuOnly({ name: "VIDA-110112", sku: "VIDA-110112", vendorCategory: "Planters" })).toBe(false);
  });

  it("is false for a real product title regardless of description", () => {
    expect(isUnresolvedSkuOnly({ name: "12-Inch Ceramic Planter, Set of 2" })).toBe(false);
  });
});

// VICK-H1PLR000 — the 36" Ivory Plume Reed Bundle. Vickerman dropped the H1PLR
// family from vickerman.com, Amazon/Walmart don't carry it, but plain Google
// resolves it instantly. These are the REAL result titles/snippets.
const GOOGLE_HITS = [
  {
    title: 'Vickerman H1PLR000 | 36" Ivory Plume Reed Bundle 7oz',
    snippet:
      "With 36 inches of preserved ivory plume reeds and 15-20 stems this bundle is perfect for creating stunning centerpieces or adding height to bouquets.",
  },
  {
    title: '36-40" Ivory Plume Reed Bundle',
    snippet: "Our Price: $24.80 Sale Price: $19.84 You save $4.96! Product Code: VIC-H1PLR000. Quantity",
  },
];

describe("skuSearchVariants", () => {
  it("emits the vendor's own code form for a prefixed sheet code", () => {
    expect(skuSearchVariants("VICK-H1PLR000")).toContain("H1PLR000");
  });
});

describe("hitsReferenceSku", () => {
  const blob = GOOGLE_HITS.map((h) => `${h.title} ${h.snippet}`).join(" ");
  const variants = skuSearchVariants("VICK-H1PLR000");

  it("accepts hits that carry the code without the sheet's vendor prefix", () => {
    // The old guard required the FULL sheet code ("VICKH1PLR000"), which no
    // retailer page ever prints — every genuine hit was rejected.
    expect(hitsReferenceSku(blob, "VICK-H1PLR000", variants)).toBe(true);
  });

  it("a degenerate digit core alone proves nothing", () => {
    // "000" appears as a number on plenty of unrelated pages.
    expect(hitsReferenceSku(
      "Ivory Plume Decor pack of 000 units", "VICK-H1PLR000", variants,
    )).toBe(false);
  });

  it("rejects loose brand-only matches (the TOV → TOTO failure)", () => {
    expect(hitsReferenceSku(
      "TOTO toilet replacement parts and accessories for all models",
      "VICK-H1PLR000",
      variants,
    )).toBe(false);
  });

  it("still accepts a bounded non-degenerate digit core", () => {
    expect(hitsReferenceSku(
      "TOV Furniture Sofa 54304 in stock", "TOVF-TOVT54304FBMP", skuSearchVariants("TOVF-TOVT54304FBMP"),
    )).toBe(true);
  });
});

describe("pickProductName", () => {
  it("picks the descriptive half of a 'Brand CODE | Product Name' title", () => {
    // Taking segment 0 unconditionally resolved this to "Vickerman H1PLR000" —
    // a brand + code, no better than the raw sheet code.
    const name = pickProductName(GOOGLE_HITS, "VICK-H1PLR000");
    expect(name).toBe('36" Ivory Plume Reed Bundle 7oz');
  });

  it("keeps a plain title without separators unchanged", () => {
    const name = pickProductName(
      [{ title: "Bonide Mosquito Beater Granules 1.3 lb", snippet: "" }],
      "BND-5612",
    );
    expect(name).toBe("Bonide Mosquito Beater Granules 1.3 lb");
  });
});
