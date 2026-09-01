import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("@/lib/ai/moonshot", () => ({
  moonshot: (m: string) => m,
  moonshotConfigured: () => true,
  moonshotTemperature: () => 0.2,
  MOONSHOT_TEXT_MODEL: "test-model",
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

  it("accepts in-slice answers, canonicalizes near-misses, drops out-of-slice ones", async () => {
    const t0 = slice[0]!;
    const t1 = slice[1]!;
    mockedGen
      .mockResolvedValueOnce(reply(JSON.stringify([
        { index: 1, productType: t0 },                     // exact
        { index: 2, productType: t1.toUpperCase() },       // near-miss → canonical
        { index: 3, productType: "Completely Different" }, // out-of-slice → blank
      ])))
      // The leftover re-pass re-asks about the blank product; it stays blank.
      .mockResolvedValue(reply(JSON.stringify([{ index: 1, productType: "" }])));
    const res = await assignSpecProductTypes([
      { id: "a", name: "product a", category: path },
      { id: "b", name: "product b", category: path },
      { id: "c", name: "product c", category: path },
    ]);
    expect(res.assigned.get("a")).toBe(t0);
    expect(res.assigned.get("b")).toBe(t1);
    expect(res.assigned.has("c")).toBe(false);
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
  });
});
