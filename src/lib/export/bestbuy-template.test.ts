import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/bestbuy/mirakl-client", () => ({
  miraklConfigured: () => true,
  getCategoryAttributes: vi.fn(),
}));
vi.mock("@/lib/ai/bestbuy-taxonomy", () => ({
  bestBuyCodeForPath: (p: string) => (p === "Automotive > Car Audio > Car Amplifiers" ? "Car_Amplifiers" : null),
}));

import { getCategoryAttributes } from "@/lib/bestbuy/mirakl-client";
import { getBestBuyColumnsForCategory, clearBestBuyTemplateCache } from "./bestbuy-template";

const attr = (code: string, label: string, required = false) => ({ code, label, required });

describe("Best Buy per-category template columns", () => {
  it("puts required attributes first and maps the fields we hold", async () => {
    clearBestBuyTemplateCache();
    vi.mocked(getCategoryAttributes).mockResolvedValueOnce([
      attr("shopSku", "Shop SKU"),
      attr("productName", "Product Name", true),
      attr("gtin", "GTIN", true),
    ]);
    const cols = (await getBestBuyColumnsForCategory("Automotive > Car Audio > Car Amplifiers"))!;
    expect(cols.map((c) => c.label)).toEqual(["Product Name", "GTIN", "Shop SKU"]);
    expect(cols.find((c) => c.code === "productName")?.fill).toBe("name");
    expect(cols.find((c) => c.code === "gtin")?.fill).toBe("upc");
  });

  it("strips the category-code prefix so scoped attributes still map", async () => {
    clearBestBuyTemplateCache();
    vi.mocked(getCategoryAttributes).mockResolvedValueOnce([
      attr("Car_Amplifiers.productWeight", "Product Weight", true),
    ]);
    const cols = (await getBestBuyColumnsForCategory("Automotive > Car Audio > Car Amplifiers"))!;
    expect(cols[0]!.fill).toBe("weight");
  });

  it("never auto-fills a NESTED attribute", async () => {
    // Regression: last-segment matching filled Feature Bullets 1-5 and Product
    // Documents 1-2 with the product description, because each code ends in
    // ".description". Wrong content in a required attribute fails Best Buy's
    // upload validation and is harder to spot than an empty cell.
    clearBestBuyTemplateCache();
    vi.mocked(getCategoryAttributes).mockResolvedValueOnce([
      attr("description", "Description", true),
      attr("featureBullets.1.description", "Feature Bullets: 1: Description", true),
      attr("productDocuments.2.description", "Product Documents: 2: Description"),
      attr("Car_Amplifiers.tradeItemHierarchy.each.weight.amount", "Trade Item Weight", true),
    ]);
    const cols = (await getBestBuyColumnsForCategory("Automotive > Car Audio > Car Amplifiers"))!;
    expect(cols.find((c) => c.code === "description")?.fill).toBe("description");
    for (const nested of ["featureBullets.1.description", "productDocuments.2.description", "Car_Amplifiers.tradeItemHierarchy.each.weight.amount"]) {
      expect(cols.find((c) => c.code === nested)?.fill).toBeUndefined();
    }
  });

  it("returns null for a category outside the taxonomy rather than a wrong sheet", async () => {
    clearBestBuyTemplateCache();
    expect(await getBestBuyColumnsForCategory("Not > A > Category")).toBeNull();
  });
});
