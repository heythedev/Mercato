import { describe, expect, it, vi } from "vitest";

// resolve-sku pulls the whole vendor-catalog chain (vickerman → keepa/walmart
// clients); the pure helpers under test need none of it.
vi.mock("./vendor-catalog", () => ({
  resolveSkuFromCatalog: vi.fn(async () => null),
  hasCatalogVendor: vi.fn(() => false),
}));

import { hitsReferenceSku, isUnresolvedSkuOnly, pickProductName, skuSearchVariants } from "./resolve-sku";

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
