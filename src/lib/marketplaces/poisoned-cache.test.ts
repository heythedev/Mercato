import { describe, it, expect, vi, beforeEach } from "vitest";

// A cached KEYWORD mapping is a fuzzy guess stored under the very barcode it
// was guessed for. When the mapped product's own barcodes contradict that
// code, re-serving it pins a wrong ASIN for the whole cache TTL — the Bonide
// mosquito-granules UPC kept resolving to a Repel DEET spray on every
// re-verify because the poisoned mapping answered before Synccentric could.
// The poisoned-mapping filter must drop it and let the rescue path re-derive;
// pack-sibling mappings (source "sibling") legitimately carry a different
// barcode and must keep being served.
vi.mock("@/lib/keepa/cache", () => ({
  getCachedCodeLookups: vi.fn(async () => new Map()),
  getCachedCascadeFailures: vi.fn(async () => new Set()),
  getCachedProducts: vi.fn(async () => new Map()),
  cacheCodeLookup: vi.fn(async () => {}),
  cacheCodeLookups: vi.fn(async () => {}),
  cacheProducts: vi.fn(async () => {}),
  newCacheStats: vi.fn(() => ({})),
  logCacheStats: vi.fn(),
}));
vi.mock("@/lib/keepa", () => ({
  getProducts: vi.fn(async () => []),
  getProductsByCode: vi.fn(async () => ({ products: [], failedCodes: [] })),
  keywordSearch: vi.fn(async () => []),
  getLastTokenInfo: vi.fn(() => ({ tokensLeft: 5000, refillRate: 300 })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  normalizeMany: vi.fn((arr: any[]) => arr),
}));
vi.mock("@/lib/keepa/client", () => ({
  refreshKeepaTokens: vi.fn(async () => ({ tokensLeft: 5000, refillRate: 300 })),
  tokensSpentMark: vi.fn(() => 0),
  tokensSpentSince: vi.fn(() => 0),
}));
vi.mock("@/lib/synccentric/client", () => ({
  synccentricConfigured: vi.fn(() => true),
  synccentricPrimary: vi.fn(() => true),
  searchByCode: vi.fn(async () => ({ products: [], failedCodes: [] })),
  searchByAsin: vi.fn(async () => []),
}));

import { verifyProducts } from "./verify";
import { getCachedCodeLookups, getCachedProducts } from "@/lib/keepa/cache";
import { searchByCode } from "@/lib/synccentric/client";

const mockedLookups = vi.mocked(getCachedCodeLookups);
const mockedProducts = vi.mocked(getCachedProducts);
const mockedSearch = vi.mocked(searchByCode);

const UPC = "037321056126";
const GTIN14 = "00037321056126";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mosquito = (): any => ({
  id: "p1",
  name: "MOSQUITO REPEL GRANUL 4K (Pack of 3)",
  vendorSku: "EMRY-7196496",
  upc: UPC,
  asin: null,
  brand: null,
  price: null,
  description: null,
  imageUrl: null,
  verifyStatus: null,
  verifyFields: null,
  vendorData: {},
});

// The wrong keyword pick: same purpose, matching pack count, DIFFERENT barcode.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const repelSpray = (): any => ({
  asin: "B0GXKZFDDH",
  title: "Repel 100 Mosquito & Insect Repellent 4 Oz, 98% DEET, 3 Pack",
  brand: "Repel",
  packageQuantity: 3,
  upcList: ["011423342103"],
  eanList: [],
  barcodes: ["011423342103"],
});

const bonideRows = () => ({
  products: [
    {
      asin: "B002YK7JVW",
      title: "Mosquito Beater Area Repellent Granules",
      brand: "Bonide",
      packageQuantity: 3,
      upcList: [UPC],
      eanList: [`0${UPC}`],
      barcodes: [UPC],
      _source: "synccentric",
    },
  ],
  failedCodes: [] as string[],
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedSearch.mockResolvedValue({ products: [], failedCodes: [] });
});

describe("poisoned keyword mappings self-heal", () => {
  it("drops a cached candidate whose barcodes contradict the code and re-derives via Synccentric", async () => {
    mockedLookups.mockResolvedValue(
      new Map([[GTIN14, { asins: ["B0GXKZFDDH"], source: "keyword" as const }]]),
    );
    mockedProducts.mockResolvedValue(new Map([["B0GXKZFDDH", repelSpray()]]));
    mockedSearch.mockResolvedValue(bonideRows());

    const [result] = await verifyProducts("amazon", [mosquito()], { skipAiPasses: true });
    expect(mockedSearch).toHaveBeenCalled(); // rescue ran instead of serving the poison
    expect(result.liveData.asin).toBe("B002YK7JVW");
    expect(result.liveData.asin).not.toBe("B0GXKZFDDH");
  });

  it("keeps serving sibling-source mappings even though their barcode differs", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sibling: any = {
      asin: "B00SIBLNG1",
      title: "Bonide Mosquito Beater Granules, 3 Pack",
      brand: "Bonide",
      packageQuantity: 3,
      upcList: ["099999999998"], // the sibling's OWN barcode — not the vendor's
      eanList: [],
      barcodes: ["099999999998"],
    };
    mockedLookups.mockResolvedValue(
      new Map([[GTIN14, { asins: ["B00SIBLNG1"], source: "sibling" as const }]]),
    );
    mockedProducts.mockResolvedValue(new Map([["B00SIBLNG1", sibling]]));

    const [result] = await verifyProducts("amazon", [mosquito()], { skipAiPasses: true });
    expect(result.liveData.asin).toBe("B00SIBLNG1");
    expect(mockedSearch).not.toHaveBeenCalled(); // served from cache, no re-derivation
  });
});
