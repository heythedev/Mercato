import { describe, it, expect, vi, beforeEach } from "vitest";

// Item 1: deterministic Spec Product Type straight from Walmart, no AI.
// Regression target: never trust the FIRST search hit — only the item id
// verification actually matched (a real run found 262/1930 UPC searches
// ranked a different listing first).

const findMatch = vi.fn();
vi.mock("@/lib/walmart/seller-client", () => ({
  findWalmartCatalogMatch: (...args: unknown[]) => findMatch(...args),
}));

import { enrichWalmartProductTypes, type VerifyResult } from "./verify";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const product = (id: string, upc: string | null): any => ({ id, upc });

function result(id: string, status: VerifyResult["status"], liveData: Record<string, unknown>): VerifyResult {
  return { productId: id, status, fields: [], liveData };
}

describe("enrichWalmartProductTypes", () => {
  beforeEach(() => findMatch.mockReset());

  it("fills productType and catalogCategoryPath from the matched item", async () => {
    findMatch.mockResolvedValue({
      itemId: "111",
      productType: "Vehicle Rotors",
      categoryPath: ["Auto & Tires", "Automotive Replacement Parts", "Brake Rotors"],
    });
    const r = result("p1", "ok", { itemId: "111" });
    await enrichWalmartProductTypes([r], [product("p1", "012345678905")]);
    expect(findMatch).toHaveBeenCalledWith("012345678905", "111");
    expect(r.liveData.productType).toBe("Vehicle Rotors");
    expect(r.liveData.catalogCategoryPath).toEqual(["Auto & Tires", "Automotive Replacement Parts", "Brake Rotors"]);
  });

  it("handles itemId stored as a JSON number — Walmart's Affiliate API returns it that way, confirmed against production data", async () => {
    findMatch.mockResolvedValue({ itemId: "13791168942", productType: "Vehicle Rotors" });
    const r = result("p1", "ok", { itemId: 13791168942 });
    await enrichWalmartProductTypes([r], [product("p1", "195700854104")]);
    expect(findMatch).toHaveBeenCalledWith("195700854104", "13791168942");
    expect(r.liveData.productType).toBe("Vehicle Rotors");
  });

  it("skips products already carrying a productType (seller-owned lookup already answered)", async () => {
    const r = result("p1", "ok", { itemId: "111", productType: "Already Set" });
    await enrichWalmartProductTypes([r], [product("p1", "012345678905")]);
    expect(findMatch).not.toHaveBeenCalled();
    expect(r.liveData.productType).toBe("Already Set");
  });

  it("skips not_found and mismatch results — no confirmed listing to ask about", async () => {
    const rs = [
      result("a", "not_found", {}),
      result("b", "mismatch", { itemId: "222" }),
      result("c", "skipped", { itemId: "333" }),
    ];
    await enrichWalmartProductTypes(rs, [product("a", "1"), product("b", "2"), product("c", "3")]);
    expect(findMatch).not.toHaveBeenCalled();
  });

  it("skips a product with no upc or no matched itemId", async () => {
    const rs = [result("a", "ok", { itemId: "1" }), result("b", "warning", {})];
    await enrichWalmartProductTypes(rs, [product("a", null), product("b", "2")]);
    expect(findMatch).not.toHaveBeenCalled();
  });

  it("leaves liveData untouched when Walmart has no match for this exact item", async () => {
    findMatch.mockResolvedValue(null);
    const r = result("p1", "warning", { itemId: "111" });
    const before = JSON.stringify(r.liveData);
    await enrichWalmartProductTypes([r], [product("p1", "012345678905")]);
    expect(JSON.stringify(r.liveData)).toBe(before);
  });

  it("processes every eligible product even when some are skipped or fail", async () => {
    findMatch.mockImplementation(async (_upc: string, itemId: string) =>
      itemId === "2" ? { itemId, productType: "Type Two" } : null,
    );
    const rs = [
      result("a", "ok", { itemId: "1" }),
      result("b", "ok", { itemId: "2" }),
      result("c", "not_found", {}),
    ];
    await enrichWalmartProductTypes(rs, [product("a", "u1"), product("b", "u2"), product("c", "u3")]);
    expect(findMatch).toHaveBeenCalledTimes(2);
    expect(rs[0].liveData.productType).toBeUndefined();
    expect(rs[1].liveData.productType).toBe("Type Two");
  });
});
