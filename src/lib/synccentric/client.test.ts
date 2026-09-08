import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchByCode, searchByPartNumber } from "./client";

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

// ── Part-number (MPN) lookup ─────────────────────────────────────────────────
// Bare-SKU vendor sheets are resolved by searching the vendor's item number as
// a manufacturer part number. Part numbers repeat across brands, so the brand
// filter is the entire safety mechanism — searching "134804" alone also returns
// Petstages, Stokke and Hayabusa products.
describe("Synccentric searchByPartNumber", () => {
  beforeEach(() => vi.stubEnv("SYNCCENTRIC_API_TOKEN", "test-token"));
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("keeps only the row whose brand matches, discarding other brands' part-number collisions", async () => {
    vi.stubGlobal("fetch", mockFetch([
      row({ asin: "B01AAAAAAA", title: "Petstages Quiet Glow Play Pair", brand: "P & P", mpn: "134804" }),
      row({ asin: "B02BBBBBBB", title: "Stokke Sleepi Junior Extension", brand: "Stokke", mpn: "134804" }),
      row({ asin: "B03CCCCCCC", title: 'vidaXL 37"x63" Velvet Blackout Curtains 2 pcs', brand: "vidaXL", mpn: "134804" }),
    ]));
    const out = await searchByPartNumber(["134804"], "vidaXL");
    expect(out.size).toBe(1);
    expect(out.get("134804")?.title).toContain("vidaXL");
  });

  it("rejects rows with NO brand — an empty brand is a substring of everything", async () => {
    // The live bug this guards: a two-way `includes` treated "" as a match and
    // wrote "Painting Knives", "Blu-ray" and "Ironing Board D" over real
    // vidaXL products before the length check was added.
    vi.stubGlobal("fetch", mockFetch([
      row({ asin: "B04DDDDDDD", title: "Holbein Steel Painting Knives No. 14", brand: "", mpn: "110114" }),
      row({ asin: "B05EEEEEEE", title: "Legends of the Dark King [Blu-ray]", mpn: "131017" }),
    ]));
    const out = await searchByPartNumber(["110114", "131017"], "vidaXL");
    expect(out.size).toBe(0);
  });

  it("drops a row whose part number is not one we asked for", async () => {
    vi.stubGlobal("fetch", mockFetch([
      row({ asin: "B06FFFFFFF", title: "vidaXL Something Else", brand: "vidaXL", mpn: "999999" }),
    ]));
    expect((await searchByPartNumber(["134804"], "vidaXL")).size).toBe(0);
  });

  it("refuses to search without a brand", async () => {
    const fetchSpy = mockFetch([]);
    vi.stubGlobal("fetch", fetchSpy);
    expect((await searchByPartNumber(["134804"], "  ")).size).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
