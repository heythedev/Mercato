import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { findWalmartCatalogMatch } from "./seller-client";

// findWalmartCatalogMatch must NEVER fall back to the search's own ranking —
// only the exact itemId verification already matched is trustworthy. A real
// 1,930-product run found 262 UPC searches whose top hit was a different
// listing than the one verification confirmed.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("findWalmartCatalogMatch", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env.WALMART_CLIENT_ID = "test-id";
    process.env.WALMART_CLIENT_SECRET = "test-secret";
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.WALMART_CLIENT_ID;
    delete process.env.WALMART_CLIENT_SECRET;
  });

  function mockFetch(searchItems: Array<Record<string, unknown>>, searchStatus = 200) {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/v3/token")) {
        return jsonResponse({ access_token: "tok", expires_in: 900 });
      }
      if (u.includes("/v3/items/walmart/search")) {
        return jsonResponse({ items: searchItems }, searchStatus);
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;
  }

  it("returns the entry matching wantItemId, never the search's top-ranked item", async () => {
    mockFetch([
      { itemId: "999", productType: "Wrong Sibling Product" },
      { itemId: "111", productType: "Vehicle Rotors", properties: { categories: ["Auto & Tires", "Brake Rotors"] } },
    ]);
    const match = await findWalmartCatalogMatch("012345678905", "111");
    expect(match).toEqual({
      itemId: "111",
      productType: "Vehicle Rotors",
      categoryPath: ["Auto & Tires", "Brake Rotors"],
    });
  });

  it("returns null when the search doesn't contain the matched item at all", async () => {
    mockFetch([{ itemId: "999", productType: "Something Else" }]);
    expect(await findWalmartCatalogMatch("012345678905", "111")).toBeNull();
  });

  it("returns null on an empty result set", async () => {
    mockFetch([]);
    expect(await findWalmartCatalogMatch("012345678905", "111")).toBeNull();
  });

  it("omits productType/categoryPath when the matched item carries neither", async () => {
    mockFetch([{ itemId: "111" }]);
    expect(await findWalmartCatalogMatch("012345678905", "111")).toEqual({ itemId: "111" });
  });

  it("returns null for empty inputs without calling the network", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;
    expect(await findWalmartCatalogMatch("", "111")).toBeNull();
    expect(await findWalmartCatalogMatch("012345678905", "")).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("degrades to undefined (not a false absence) when the response can't be parsed", async () => {
    global.fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/v3/token")) return jsonResponse({ access_token: "tok", expires_in: 900 });
      return new Response("not json", { status: 200 });
    }) as unknown as typeof fetch;
    const result = await findWalmartCatalogMatch("012345678905", "111");
    expect(result).toBeUndefined();
  });
});
