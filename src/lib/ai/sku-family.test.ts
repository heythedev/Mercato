import { describe, it, expect } from "vitest";
import {
  skuFamilyKey,
  inheritFamilyCategories,
  FAMILY_INHERIT_CONFIDENCE,
  type FamilyRow,
} from "./sku-family";

const FAUX_STEMS = "Decor 1 > Flowers & Plants > Faux Stems";
const FAUX_PLANTS = "Decor 1 > Flowers & Plants > Faux Plants";

/** A categorized row: real resolved name, earned confidence. */
function source(id: string, sku: string, category: string, confidence = 0.9): FamilyRow {
  return { id, sku, name: `Resolved product name for ${sku}`, category, path: category, confidence };
}

/** An uncategorized row whose name is still the raw code. */
function rawTarget(id: string, sku: string): FamilyRow {
  return { id, sku, name: sku, category: "Uncategorized", path: "Uncategorized", confidence: 0.1 };
}

describe("skuFamilyKey", () => {
  it("strips trailing variant digits after normalizing separators", () => {
    expect(skuFamilyKey("VICK-H1PLR150")).toBe("VICKH1PLR");
    expect(skuFamilyKey("VICK-H4RDM0002")).toBe("VICKH4RDM");
    expect(skuFamilyKey("vick-h1stb112")).toBe("VICKH1STB");
    expect(skuFamilyKey("VICK-COMBO152")).toBe("VICKCOMBO");
  });

  it("rejects families too short to denote a product line", () => {
    // "ABC" would match everything the vendor sells.
    expect(skuFamilyKey("ABC-12345")).toBeNull();
    expect(skuFamilyKey("A1")).toBeNull();
  });

  it("rejects codes without a 2+ digit variant tail", () => {
    expect(skuFamilyKey("VICKERMAN")).toBeNull(); // no digits at all
    expect(skuFamilyKey("SOFABED1")).toBeNull(); // single digit isn't a variant run
    expect(skuFamilyKey("VICK-C164202LEDWW")).toBeNull(); // tail is letters
    expect(skuFamilyKey("12345678")).toBeNull(); // all digits, no family
  });

  it("handles null/empty input", () => {
    expect(skuFamilyKey(null)).toBeNull();
    expect(skuFamilyKey(undefined)).toBeNull();
    expect(skuFamilyKey("")).toBeNull();
    expect(skuFamilyKey("  ")).toBeNull();
  });
});

describe("inheritFamilyCategories", () => {
  it("inherits from a unanimous multi-sibling family (H1PLR)", () => {
    const rows = [
      source("p1", "VICK-H1PLR450", FAUX_STEMS),
      source("p2", "VICK-H1PLR000", FAUX_STEMS),
      source("p3", "VICK-H1PLR300", FAUX_STEMS),
      rawTarget("u1", "VICK-H1PLR150"),
    ];
    const out = inheritFamilyCategories(rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      productId: "u1",
      category: FAUX_STEMS,
      path: FAUX_STEMS,
      confidence: FAMILY_INHERIT_CONFIDENCE,
      family: "VICKH1PLR",
      siblings: 3,
    });
  });

  it("allows a single sibling to vouch for a single unresolved code (H1STB)", () => {
    const rows = [source("p1", "VICK-H1STB115", FAUX_STEMS), rawTarget("u1", "VICK-H1STB112")];
    const out = inheritFamilyCategories(rows);
    expect(out).toHaveLength(1);
    expect(out[0].productId).toBe("u1");
    expect(out[0].category).toBe(FAUX_STEMS);
  });

  it("blocks a single sibling from stamping a crowd (thin fan-out guard)", () => {
    // One manually-fixed COMBO must not silently categorize all the others.
    const rows = [
      source("p1", "VICK-COMBO101", FAUX_PLANTS),
      rawTarget("u1", "VICK-COMBO152"),
      rawTarget("u2", "VICK-COMBO181"),
      rawTarget("u3", "VICK-COMBO203"),
    ];
    expect(inheritFamilyCategories(rows)).toHaveLength(0);
  });

  it("two unanimous siblings may vouch for many", () => {
    const rows = [
      source("p1", "VICK-H4RDM0001", FAUX_PLANTS),
      source("p2", "VICK-H4RDM0003", FAUX_PLANTS),
      rawTarget("u1", "VICK-H4RDM0002"),
      rawTarget("u2", "VICK-H4RDM0004"),
    ];
    const out = inheritFamilyCategories(rows);
    expect(out.map((r) => r.productId).sort()).toEqual(["u1", "u2"]);
  });

  it("never inherits when the family disagrees on category", () => {
    const rows = [
      source("p1", "VICK-H2UVA100", FAUX_STEMS),
      source("p2", "VICK-H2UVA200", FAUX_PLANTS),
      source("p3", "VICK-H2UVA300", FAUX_STEMS),
      rawTarget("u1", "VICK-H2UVA150"),
    ];
    expect(inheritFamilyCategories(rows)).toHaveLength(0);
  });

  it("produces nothing for a family with no resolved siblings (H2CAR, COMBO)", () => {
    const rows = [
      rawTarget("u1", "VICK-H2CAR725"),
      rawTarget("u2", "VICK-COMBO152"),
      rawTarget("u3", "VICK-COMBO181"),
    ];
    expect(inheritFamilyCategories(rows)).toHaveLength(0);
  });

  it("ignores fallback-stamped siblings (confidence <= 0.1) as sources", () => {
    const rows = [
      { ...source("p1", "VICK-H1PLR450", FAUX_STEMS), confidence: 0.1 },
      rawTarget("u1", "VICK-H1PLR150"),
    ];
    expect(inheritFamilyCategories(rows)).toHaveLength(0);
  });

  it("never touches an uncategorized product that has a real resolved name", () => {
    // A human-readable name means the AI already judged it on real evidence
    // and (rightly or wrongly) said Uncategorized — inheritance stays out.
    const rows = [
      source("p1", "VICK-H1PLR450", FAUX_STEMS),
      source("p2", "VICK-H1PLR000", FAUX_STEMS),
      {
        id: "u1",
        sku: "VICK-H1PLR150",
        name: "Green Plume Reed Bundle 59 inch",
        category: "Uncategorized",
        path: "Uncategorized",
        confidence: 0.3,
      },
    ];
    expect(inheritFamilyCategories(rows)).toHaveLength(0);
  });

  it("never overwrites an already-categorized row", () => {
    const rows = [
      source("p1", "VICK-H1PLR450", FAUX_STEMS),
      source("p2", "VICK-H1PLR000", FAUX_PLANTS, 0.4), // resolved differently — stays
    ];
    expect(inheritFamilyCategories(rows)).toHaveLength(0);
  });

  it("treats null/empty categories as unresolved targets", () => {
    const rows = [
      source("p1", "VICK-H1STB115", FAUX_STEMS),
      { id: "u1", sku: "VICK-H1STB112", name: "VICK-H1STB112", category: null, confidence: null },
    ];
    const out = inheritFamilyCategories(rows);
    expect(out).toHaveLength(1);
    expect(out[0].productId).toBe("u1");
  });

  it("falls back to the name for the family key when the SKU column is empty", () => {
    const rows = [
      source("p1", "VICK-H1STB115", FAUX_STEMS),
      { id: "u1", sku: null, name: "VICK-H1STB112", category: "Uncategorized", confidence: 0.1 },
    ];
    const out = inheritFamilyCategories(rows);
    expect(out).toHaveLength(1);
    expect(out[0].productId).toBe("u1");
  });

  it("inherits the sibling's path when it differs from the category", () => {
    const rows = [
      {
        id: "p1",
        sku: "VICK-H1PLR450",
        name: "Plume Reed 45in",
        category: "Faux Stems",
        path: FAUX_STEMS,
        confidence: 0.9,
      },
      rawTarget("u1", "VICK-H1PLR150"),
    ];
    const out = inheritFamilyCategories(rows);
    expect(out[0].category).toBe("Faux Stems");
    expect(out[0].path).toBe(FAUX_STEMS);
  });
});
