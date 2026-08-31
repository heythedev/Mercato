import { describe, it, expect, vi, beforeEach } from "vitest";

// enrichCandidatePackData orchestrates two sources; mock both so the tests pin
// the source order without touching the network or the DB-backed cache.
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
  getLastTokenInfo: vi.fn(() => ({ tokensLeft: 5000, refillRate: 300 })),
  // Raw test payloads already carry normalized field names — pass them through.
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
  synccentricPrimary: vi.fn(() => false),
  searchByAsin: vi.fn(async () => []),
}));

import { enrichCandidatePackData } from "./verify";
import { getCachedProducts, cacheProducts } from "@/lib/keepa/cache";
import { getProducts } from "@/lib/keepa";
import { searchByAsin, synccentricConfigured, synccentricPrimary } from "@/lib/synccentric/client";

const mockedCache = vi.mocked(getCachedProducts);
const mockedKeepa = vi.mocked(getProducts);
const mockedSync = vi.mocked(searchByAsin);
const mockedConfigured = vi.mocked(synccentricConfigured);
const mockedPrimary = vi.mocked(synccentricPrimary);

beforeEach(() => {
  vi.clearAllMocks();
  mockedCache.mockResolvedValue(new Map());
  mockedKeepa.mockResolvedValue([]);
  mockedSync.mockResolvedValue([]);
  mockedConfigured.mockReturnValue(true);
  mockedPrimary.mockReturnValue(false);
});

// EMRY-3060571's hidden 12-case: provider row had packageQuantity null.
const jellyJar = () => ({ asin: "B0044URDYI", title: "FIXTURE JELLY JAR 1LT BL" });

describe("enrichCandidatePackData — Keepa-led fallback mode", () => {
  it("fills the pack count from Synccentric when Keepa is token-starved", async () => {
    mockedKeepa.mockRejectedValue(new Error("insufficient tokens"));
    mockedSync.mockResolvedValue([
      { asin: "B0044URDYI", packageQuantity: 12, _source: "synccentric" },
    ]);
    const c = jellyJar();
    await enrichCandidatePackData([c]);
    expect(c).toHaveProperty("packageQuantity", 12);
    expect(mockedSync).toHaveBeenCalledWith(["B0044URDYI"]);
  });

  it("asks Synccentric only for ASINs Keepa left blind", async () => {
    mockedKeepa.mockResolvedValue([{ asin: "B0044URDYI", packageQuantity: 12 }]);
    const filled = jellyJar();
    const stillBlind = { asin: "B00QSC2K0C", title: "FIXTURE JELLY JAR 1LT BL (Pkg of 3)" };
    await enrichCandidatePackData([filled, stillBlind]);
    expect(filled).toHaveProperty("packageQuantity", 12);
    expect(mockedSync).toHaveBeenCalledWith(["B00QSC2K0C"]);
  });

  it("never overrides an explicit provider value and touches no source when nothing is blind", async () => {
    const explicit = { asin: "B00QSC2K0C", title: "…", packageQuantity: 3 };
    await enrichCandidatePackData([explicit]);
    expect(explicit.packageQuantity).toBe(3);
    expect(mockedKeepa).not.toHaveBeenCalled();
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("leaves candidates untouched when Synccentric is not configured", async () => {
    mockedConfigured.mockReturnValue(false);
    const c = jellyJar();
    await enrichCandidatePackData([c]);
    expect(c).not.toHaveProperty("packageQuantity");
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("ignores Synccentric rows without a usable count", async () => {
    mockedSync.mockResolvedValue([
      { asin: "B0044URDYI", packageQuantity: undefined, _source: "synccentric" },
    ]);
    const c = jellyJar();
    await enrichCandidatePackData([c]);
    expect(c).not.toHaveProperty("packageQuantity");
  });

  it("never writes Synccentric answers into the Keepa cache", async () => {
    mockedSync.mockResolvedValue([
      { asin: "B0044URDYI", packageQuantity: 12, _source: "synccentric" },
    ]);
    await enrichCandidatePackData([jellyJar()]);
    expect(vi.mocked(cacheProducts)).not.toHaveBeenCalled();
  });
});

describe("enrichCandidatePackData — Synccentric-primary mode", () => {
  beforeEach(() => mockedPrimary.mockReturnValue(true));

  it("asks Synccentric first for pack counts, before spending Keepa tokens", async () => {
    mockedSync.mockResolvedValue([
      { asin: "B0044URDYI", packageQuantity: 12, _source: "synccentric" },
    ]);
    const c = jellyJar();
    await enrichCandidatePackData([c]);
    expect(c).toHaveProperty("packageQuantity", 12);
    expect(mockedSync.mock.invocationCallOrder[0]).toBeLessThan(
      mockedKeepa.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("backfills ranking signals from Keepa for Synccentric-sourced candidates", async () => {
    // Synccentric knows the pack but stores no rank/reviews — without them
    // listingQuality can't tell a canonical listing from a reseller relist.
    mockedSync.mockResolvedValue([
      { asin: "B0044URDYI", packageQuantity: 12, _source: "synccentric" },
    ]);
    mockedKeepa.mockResolvedValue([
      { asin: "B0044URDYI", salesRank: 412000, reviewCount: 31, offerCount: 3 },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any);
    const c = jellyJar();
    await enrichCandidatePackData([c]);
    expect(c).toMatchObject({ packageQuantity: 12, salesRank: 412000, reviewCount: 31 });
  });

  it("keeps Synccentric's pack answer when Keepa is token-starved", async () => {
    mockedSync.mockResolvedValue([
      { asin: "B0044URDYI", packageQuantity: 12, _source: "synccentric" },
    ]);
    mockedKeepa.mockRejectedValue(new Error("insufficient tokens"));
    const c = jellyJar();
    await enrichCandidatePackData([c]);
    expect(c).toHaveProperty("packageQuantity", 12);
  });

  it("skips Keepa entirely when candidates already carry pack and rank data", async () => {
    const complete = {
      asin: "B00002N5CR", title: "Westinghouse Jelly Jar",
      packageQuantity: 1, salesRank: 516275, reviewCount: 87,
    };
    await enrichCandidatePackData([complete]);
    expect(mockedKeepa).not.toHaveBeenCalled();
    expect(mockedSync).not.toHaveBeenCalled();
  });
});
