import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchByCode } from "./client";

// Synccentric changed package_quantity from a number to a STRING ("3", "12",
// "") around 2026-08-28. The old typeof === "number" mapping silently nulled
// every pack count, wiped out the pack filter, and re-opened wrong-pack ASIN
// picks (the mosquito Pack-of-3 kept resolving to singles/10-packs).
const row = (attrs: Record<string, unknown>) => ({ attributes: attrs });

function mockFetch(rows: unknown[]) {
  return vi.fn(async () =>
    new Response(JSON.stringify({ data: rows }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

describe("Synccentric pack-quantity coercion", () => {
  beforeEach(() => {
    vi.stubEnv("SYNCCENTRIC_API_TOKEN", "test-token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("coerces string package_quantity values to numbers", async () => {
    vi.stubGlobal("fetch", mockFetch([
      row({ asin: "B002YK7JVW", title: "Mosquito Beater Area Repellent Granules", upc: "037321056126", package_quantity: "3" }),
    ]));
    const { products } = await searchByCode(["037321056126"]);
    expect(products[0]?.packageQuantity).toBe(3);
  });

  it("blank/zero/garbage pack values stay undefined", async () => {
    vi.stubGlobal("fetch", mockFetch([
      row({ asin: "B000UJTBWE", title: "Granules", upc: "037321056126", package_quantity: "" }),
      row({ asin: "B001WPOET0", title: "Granules", upc: "037321056126", package_quantity: "0" }),
      row({ asin: "B007RGCRRY", title: "Granules", upc: "037321056126", package_quantity: "n/a" }),
    ]));
    const { products } = await searchByCode(["037321056126"]);
    expect(products.map((p) => p.packageQuantity)).toEqual([undefined, undefined, undefined]);
  });

  it("still accepts numeric package_quantity and maps number_of_items", async () => {
    vi.stubGlobal("fetch", mockFetch([
      row({ asin: "B00IMKY9X4", title: "3 each: Granules", upc: "037321056126", package_quantity: 12, number_of_items: "12" }),
    ]));
    const { products } = await searchByCode(["037321056126"]);
    expect(products[0]?.packageQuantity).toBe(12);
    expect(products[0]?.numberOfItems).toBe(12);
  });
});
