import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("@/lib/ai/moonshot", () => ({
  moonshot: (m: string) => m,
  moonshotConfigured: () => true,
  moonshotTemperature: () => 0.2,
  MOONSHOT_TEXT_MODEL: "test-model",
  // AI availability guard: no outage in these tests, every failure transient.
  getAiOutage: () => null,
  classifyAiError: (e: unknown) => ({ fatal: false, reason: String(e) }),
  AiUnavailableError: class AiUnavailableError extends Error {
    constructor(readonly reason: string) { super(reason); }
  },
}));

import { generateText } from "ai";
import {
  assignSpecProductTypes,
  isSpecTypeCurrent,
  matchSpecTypeByName,
  normSpecType,
  parseSpecTypeReply,
} from "./walmart-spec-product-type";
import { loadWalmartRawTaxonomy } from "./walmart-taxonomy";

const mockedGen = vi.mocked(generateText);

// Use a REAL taxonomy slice (data files load from disk, precedent:
// walmart-approved.test.ts) so slice validation runs against actual paths.
function realScope(): { path: string; slice: string[] } {
  const raw = loadWalmartRawTaxonomy();
  if (!raw) throw new Error("walmart_taxonomy_raw.json missing");
  for (const c of raw) {
    for (const g of c.groups) {
      if (g.types.length >= 5) return { path: `${c.category} > ${g.name}`, slice: g.types };
    }
  }
  throw new Error("no group with enough types");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reply = (text: string): any => ({ text });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseSpecTypeReply", () => {
  it("parses clean JSON, fenced JSON, and prose-wrapped JSON", () => {
    const arr = [{ index: 1, productType: "Table Lamps" }];
    expect(parseSpecTypeReply(JSON.stringify(arr))).toEqual(arr);
    expect(parseSpecTypeReply("```json\n" + JSON.stringify(arr) + "\n```")).toEqual(arr);
    expect(parseSpecTypeReply("Here you go:\n" + JSON.stringify(arr) + "\nDone.")).toEqual(arr);
  });

  it("recovers per-object fragments from a truncated reply", () => {
    const truncated = '[{"index":1,"productType":"Table Lamps"},{"index":2,"productType":"Desk La';
    expect(parseSpecTypeReply(truncated)).toEqual([{ index: 1, productType: "Table Lamps" }]);
  });

  it("returns null (a FAILED attempt, not a silent blank) for garbage", () => {
    expect(parseSpecTypeReply("I could not classify these products.")).toBeNull();
    expect(parseSpecTypeReply("")).toBeNull();
  });
});

describe("matchSpecTypeByName", () => {
  it("finds a whole type name inside the product name, longest wins", () => {
    const types = ["Lamps", "Table Lamps", "Desk Lamps"];
    expect(matchSpecTypeByName("Modern Table Lamps Set of 2", types)).toBe("Table Lamps");
  });

  it("is plural/punctuation tolerant", () => {
    expect(matchSpecTypeByName("modern table lamp, brushed nickel", ["Table Lamps"])).toBe("Table Lamps");
  });

  it("ambiguous equal-length distinct matches return null", () => {
    // "desk lamp" and "wall lamp" normalize to the same length — a true tie.
    expect(matchSpecTypeByName("Desk Lamps and Wall Lamps bundle", ["Desk Lamps", "Wall Lamps"])).toBeNull();
  });

  it("requireMultiWord skips promiscuous single-word types", () => {
    expect(matchSpecTypeByName("Blue Area Rugs 8x10", ["Rugs"], { requireMultiWord: true })).toBeNull();
    expect(matchSpecTypeByName("Blue Area Rugs 8x10", ["Area Rugs"], { requireMultiWord: true })).toBe("Area Rugs");
  });
});

describe("isSpecTypeCurrent", () => {
  const { path, slice } = realScope();
  const validNorm = new Set(slice.map(normSpecType));

  it("valid + in-slice is current", () => {
    expect(isSpecTypeCurrent(slice[0], path, validNorm)).toBe(true);
  });

  it("valid but out-of-slice for a resolvable path is NOT current (category changed)", () => {
    // A type valid globally but absent from this path's slice must re-derive.
    const foreign = "Zzz Not In Slice";
    const withForeign = new Set([...validNorm, normSpecType(foreign)]);
    expect(isSpecTypeCurrent(foreign, path, withForeign)).toBe(false);
  });

  it("valid + unresolvable path is current (nothing to check against)", () => {
    const validAll = new Set([normSpecType("Table Lamps")]);
    expect(isSpecTypeCurrent("Table Lamps", "No Such Category > Nope", validAll)).toBe(true);
  });

  it("blank or off-list is never current", () => {
    expect(isSpecTypeCurrent(null, path, validNorm)).toBe(false);
    expect(isSpecTypeCurrent("Invented Type", path, validNorm)).toBe(false);
  });

  it("a level-fallback value matching the CURRENT path's deepest segment is current", () => {
    const group = path.split(">").map((s) => s.trim()).at(-1)!;
    // Not on the valid-types list (it's a Group name, not a real Product
    // Type) — still current, because it's exactly what the fallback would
    // recompute for this same path, so re-attempting can't change anything.
    expect(isSpecTypeCurrent(group, path, validNorm)).toBe(true);
  });

  it("a level-fallback value from a DIFFERENT path is NOT current (category changed)", () => {
    const group = path.split(">").map((s) => s.trim()).at(-1)!;
    expect(isSpecTypeCurrent(group, "Some Other Category > Some Other Group", validNorm)).toBe(false);
  });
});

describe("assignSpecProductTypes", () => {
  const { path, slice } = realScope();

  it("deterministic pre-pass answers without the AI and persists via onAssigned", async () => {
    const target = slice.find((t) => /\s/.test(t)) ?? slice[0]!;
    const persisted: Array<{ productId: string; specProductType: string }> = [];
    const res = await assignSpecProductTypes(
      [{ id: "p1", name: `Acme ${target} Deluxe`, category: path }],
      { onAssigned: async (rows) => { persisted.push(...rows); } },
    );
    expect(res.assigned.get("p1")).toBe(target);
    expect(persisted).toEqual([{ productId: "p1", specProductType: target }]);
    expect(mockedGen).not.toHaveBeenCalled();
  });

  it("accepts in-slice answers, canonicalizes near-misses, level-falls-back the rest", async () => {
    const t0 = slice[0]!;
    const t1 = slice[1]!;
    mockedGen
      .mockResolvedValueOnce(reply(JSON.stringify([
        { index: 1, productType: t0 },                     // exact
        { index: 2, productType: t1.toUpperCase() },       // near-miss → canonical
        { index: 3, productType: "Completely Different" }, // out-of-slice → blank
      ])))
      // The leftover re-pass re-asks about the blank product; it stays blank —
      // a genuinely exhausted attempt, so it should level-fall-back, not stay empty.
      .mockResolvedValue(reply(JSON.stringify([{ index: 1, productType: "" }])));
    const res = await assignSpecProductTypes([
      { id: "a", name: "product a", category: path },
      { id: "b", name: "product b", category: path },
      { id: "c", name: "product c", category: path },
    ]);
    expect(res.assigned.get("a")).toBe(t0);
    expect(res.assigned.get("b")).toBe(t1);
    // "c" never got a real type from any round — falls back to the deepest
    // resolved category level (the Product Type Group, the path's last segment).
    expect(res.assigned.get("c")).toBe(path.split(">").map((s) => s.trim()).at(-1));
    expect(res.levelFallback).toBe(1);
  });

  it("retries a failed batch instead of silently blanking it", async () => {
    const t0 = slice[0]!;
    mockedGen
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(reply(JSON.stringify([{ index: 1, productType: t0 }])));
    const res = await assignSpecProductTypes([{ id: "a", name: "product a", category: path }]);
    expect(res.assigned.get("a")).toBe(t0);
    expect(mockedGen.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a past deadline stops before any AI call and reports deadlineHit", async () => {
    const target = slice.find((t) => /\s/.test(t)) ?? slice[0]!;
    const persisted: Array<{ productId: string; specProductType: string }> = [];
    const res = await assignSpecProductTypes(
      [
        { id: "pre", name: `Acme ${target}`, category: path }, // pre-pass still lands
        { id: "ai", name: "needs the model", category: path },
      ],
      { deadlineAt: Date.now() - 1000, onAssigned: async (rows) => { persisted.push(...rows); } },
    );
    expect(res.deadlineHit).toBe(true);
    expect(res.assigned.get("pre")).toBe(target);
    expect(persisted.some((r) => r.productId === "pre")).toBe(true);
    expect(mockedGen).not.toHaveBeenCalled();
    // Never reached by the deadline — must stay blank for the resumed
    // invocation's real attempt, not get locked into a premature fallback.
    expect(res.assigned.has("ai")).toBe(false);
  });

  it("level-falls-back to the deepest resolved segment when nothing in the group's real list fits", async () => {
    mockedGen.mockResolvedValue(reply(JSON.stringify([{ index: 1, productType: "" }])));
    const persisted: Array<{ productId: string; specProductType: string }> = [];
    const res = await assignSpecProductTypes(
      [{ id: "a", name: "product a", category: path }],
      { onAssigned: async (rows) => { persisted.push(...rows); } },
    );
    const group = path.split(">").map((s) => s.trim()).at(-1);
    expect(res.assigned.get("a")).toBe(group);
    expect(res.levelFallback).toBe(1);
    expect(persisted.some((r) => r.productId === "a" && r.specProductType === group)).toBe(true);
  });

  it("falls back to the whole path when it has no group segment to split on", async () => {
    mockedGen.mockResolvedValue(reply(JSON.stringify([{ index: 1, productType: "" }])));
    const res = await assignSpecProductTypes([
      { id: "a", name: "product a", category: "Just A Category" },
    ]);
    expect(res.assigned.get("a")).toBe("Just A Category");
  });

  it("stays blank when the product has no category to fall back to at all", async () => {
    mockedGen.mockResolvedValue(reply(JSON.stringify([{ index: 1, productType: "" }])));
    const res = await assignSpecProductTypes([{ id: "a", name: "product a", category: null }]);
    expect(res.assigned.has("a")).toBe(false);
    expect(res.levelFallback).toBe(0);
  });
});
