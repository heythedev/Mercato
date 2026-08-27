import { describe, it, expect, vi, beforeEach } from "vitest";

// A barcode cached as "Keepa doesn't map this" must still reach Synccentric —
// in BOTH source orders. Cached-absent codes are excluded from the main batch,
// so the per-product rescue is their only Synccentric lookup; when it was
// gated to fallback mode only, primary mode sent these products straight to
// keyword guessing past a database that had the exact answer (the Bonide
// mosquito-granules case from project "aaaa").
vi.mock("@/lib/keepa/cache", () => ({
  getCachedCodeLookups: vi.fn(async () => new Map()),
  getCachedCascadeFailures: vi.fn(async () => new Map()),
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
import { getCachedCodeLookups } from "@/lib/keepa/cache";
import { searchByCode, synccentricConfigured, synccentricPrimary } from "@/lib/synccentric/client";

const mockedLookups = vi.mocked(getCachedCodeLookups);
const mockedSearch = vi.mocked(searchByCode);
const mockedConfigured = vi.mocked(synccentricConfigured);
const mockedPrimary = vi.mocked(synccentricPrimary);

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

const bonideRows = () => ({
  products: [
    {
      asin: "B002YK7JVW",
      title: "Mosquito Beater Area Repellent Granules",
      brand: "Bonide",
      packageQuantity: 3,
      upcList: [UPC],
      eanList: [`0${UPC}`],
      _source: "synccentric",
    },
    {
      asin: "B001WPOET0",
      title: "Bonide 5612 1.3 Lb Mosquito Beater Area Mosquito Repellent",
      brand: "Bonide",
      packageQuantity: 12,
      upcList: [UPC],
      eanList: [`0${UPC}`],
      _source: "synccentric",
    },
  ],
  failedCodes: [] as string[],
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedLookups.mockResolvedValue(new Map([[GTIN14, []]])); // cached absence
  mockedSearch.mockResolvedValue({ products: [], failedCodes: [] });
  mockedConfigured.mockReturnValue(true);
  mockedPrimary.mockReturnValue(true);
});

describe("cached-absent barcodes still reach Synccentric", () => {
  it("primary mode: resolves from Synccentric instead of keyword-guessing", async () => {
    mockedSearch.mockResolvedValue(bonideRows());
    const [result] = await verifyProducts("amazon", [mosquito()], { skipAiPasses: true });
    expect(mockedSearch).toHaveBeenCalled();
    expect(result.liveData.asin).toBe("B002YK7JVW"); // the pack-compatible 3-pack
    expect(result.status).not.toBe("not_found");
  });

  it("fallback mode: keeps the pre-existing Synccentric rescue", async () => {
    mockedPrimary.mockReturnValue(false);
    mockedSearch.mockResolvedValue(bonideRows());
    const [result] = await verifyProducts("amazon", [mosquito()], { skipAiPasses: true });
    expect(mockedSearch).toHaveBeenCalled();
    expect(result.liveData.asin).toBe("B002YK7JVW");
  });

  it("without Synccentric the absence degrades to the keyword cascade, not a crash", async () => {
    mockedConfigured.mockReturnValue(false);
    const [result] = await verifyProducts("amazon", [mosquito()], { skipAiPasses: true });
    expect(mockedSearch).not.toHaveBeenCalled();
    expect(result.status).toBe("not_found"); // keyword search found nothing
  });
});
