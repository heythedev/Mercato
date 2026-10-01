import { describe, expect, it } from "vitest";
import {
  INLINE_TAXONOMY_MAX,
  canonicalCategory,
  categoryIndex,
  categoryKey,
  categoryPathsFor,
  nextSegments,
  resolveAssignments,
} from "./taxonomy";

/**
 * The guard that lets a second thing assign categories.
 *
 * Mercato's batch categoriser is held to these files. So is anything else, or
 * the two drift and the export silently files products under a department no
 * template matches — while the product now LOOKS categorised, so the real
 * categoriser never revisits it. Nothing errors; a client gets the wrong sheet.
 */

const MATHIS = categoryIndex("mathis")!;

describe("the marketplace's own list", () => {
  it("loads a real taxonomy for every marketplace that ships one", () => {
    for (const mp of ["mathis", "bestbuy", "temu", "sears", "walmart"]) {
      const paths = categoryPathsFor(mp);
      expect(paths, mp).not.toBeNull();
      expect(paths!.length, mp).toBeGreaterThan(0);
      expect(paths!.every((p) => p.includes(">")), mp).toBe(true);
    }
  });

  it("is the SAME list the batch categoriser uses", async () => {
    // Not a copy kept in step by hand — the identical loader.
    const { loadMathisCategoryPaths } = await import("@/lib/ai/mathis-taxonomy");
    expect(categoryPathsFor("mathis")).toEqual(loadMathisCategoryPaths());
  });

  it("returns null for a marketplace with no list, rather than waving it through", () => {
    // Null must make callers REFUSE. An unknown marketplace is exactly when a
    // typo would otherwise go unnoticed.
    expect(categoryPathsFor("etsy")).toBeNull();
    expect(categoryIndex("etsy")).toBeNull();
  });

  it("does not care how the marketplace is spelled", () => {
    expect(categoryPathsFor(" Mathis ")).not.toBeNull();
    expect(categoryPathsFor("MATHIS")).not.toBeNull();
  });
});

describe("matching a proposed path", () => {
  it("accepts a real path and returns the canonical spelling", () => {
    const real = MATHIS.paths[0];
    expect(canonicalCategory(MATHIS, real)).toBe(real);
  });

  it("forgives case and spacing, because that is not the mistake that hurts", () => {
    const real = MATHIS.paths.find((p) => p.split(" > ").length >= 3)!;
    const mangled = real.toLowerCase().split(" > ").join("  >  ");
    expect(canonicalCategory(MATHIS, mangled)).toBe(real);
  });

  it("stores the canonical spelling, never what arrived", () => {
    // Otherwise two spellings of one category become two export groups.
    const real = MATHIS.paths[0];
    const { accepted } = resolveAssignments(MATHIS, [
      { productId: "p1", category: real.toUpperCase() },
    ]);
    expect(accepted[0].category).toBe(real);
  });

  it("refuses a TRUNCATED path — the failure this exists to stop", () => {
    // "Furniture" instead of "Furniture > Living Room > Sofas" makes the
    // export read the first segment as a department, match no template, and
    // fall back to the wrong workbook.
    const department = MATHIS.paths[0].split(" > ")[0];
    expect(canonicalCategory(MATHIS, department)).toBeNull();
  });

  it("refuses an invented path however plausible", () => {
    for (const made of [
      "Furniture > Living Room > Beanbags",
      "Sofas",
      "Furniture > Sofas",
      "Garden > Sheds",
      "",
    ]) {
      expect(canonicalCategory(MATHIS, made), made).toBeNull();
    }
  });
});

describe("resolving a batch", () => {
  const real = () => MATHIS.paths.slice(0, 3);

  it("writes the good ones and refuses the rest", () => {
    // Partial on purpose: 39 right out of 40 should write 39. The refused
    // products stay uncategorised, so the next batch picks them up — the
    // retry is the existing loop, not special handling.
    const [a, b] = real();
    const { accepted, rejected } = resolveAssignments(MATHIS, [
      { productId: "p1", category: a },
      { productId: "p2", category: "Not A Real Category" },
      { productId: "p3", category: b },
    ]);
    expect(accepted.map((x) => x.productId)).toEqual(["p1", "p3"]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].productId).toBe("p2");
    expect(rejected[0].reason).toContain("mathis");
  });

  it("refuses the same product listed twice", () => {
    // Picking one silently would make the result depend on array order.
    const [a, b] = real();
    const { accepted, rejected } = resolveAssignments(MATHIS, [
      { productId: "p1", category: a },
      { productId: "p1", category: b },
    ]);
    expect(accepted).toHaveLength(1);
    expect(rejected[0].reason).toContain("twice");
  });

  it("refuses an empty category or a missing id", () => {
    const { accepted, rejected } = resolveAssignments(MATHIS, [
      { productId: "", category: real()[0] },
      { productId: "p2", category: "   " },
    ]);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(2);
  });

  it("keeps confidence in range and defaults it sensibly", () => {
    const a = real()[0];
    const { accepted } = resolveAssignments(MATHIS, [
      { productId: "p1", category: a },
      { productId: "p2", category: a, confidence: 0.2 },
      { productId: "p3", category: a, confidence: 7 },
      { productId: "p4", category: a, confidence: -3 },
      { productId: "p5", category: a, confidence: Number.NaN },
    ]);
    expect(accepted[0].confidence).toBeGreaterThan(0.6); // above the reuse threshold
    expect(accepted[1].confidence).toBe(0.2); // a low score is kept, not "fixed"
    expect(accepted[2].confidence).toBe(1);
    expect(accepted[3].confidence).toBe(0);
    expect(accepted[4].confidence).toBeGreaterThan(0.6);
  });

  it("never accepts anything absent from the list, over the whole taxonomy", () => {
    // The property, rather than the handful of cases above.
    const proposals = MATHIS.paths.map((p, i) => ({ productId: `p${i}`, category: p }));
    const { accepted, rejected } = resolveAssignments(MATHIS, proposals);
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(MATHIS.paths.length);
    for (const x of accepted) expect(MATHIS.paths).toContain(x.category);
  });
});

describe("how big each list actually is", () => {
  // Pinned because the inline-vs-drill decision turns on it, and because I
  // first read these off the CSVs' line counts and got Walmart badly wrong —
  // its 5,242-line file is a product-type mapping, not assignable paths.
  it("matches what the loaders return", () => {
    const sizes = Object.fromEntries(
      ["sears", "walmart", "mathis", "temu", "bestbuy"].map((mp) => [mp, categoryPathsFor(mp)!.length]),
    );
    expect(sizes).toEqual({ sears: 329, walmart: 492, mathis: 504, temu: 717, bestbuy: 1450 });
  });

  it("every one of them fits in a batch today", () => {
    for (const mp of ["sears", "walmart", "mathis", "temu", "bestbuy"]) {
      expect(categoryPathsFor(mp)!.length, mp).toBeLessThanOrEqual(INLINE_TAXONOMY_MAX);
    }
  });

  it("Wayfair has no usable list, so it must refuse rather than guess", () => {
    // Its CSV is a stub, and the Wayfair export is disabled for the same
    // reason — a tool that accepted any string here would be the one place
    // Wayfair data could be written unchecked.
    expect(categoryPathsFor("wayfair")).toBeNull();
    expect(categoryIndex("wayfair")).toBeNull();
  });
});

describe("drilling into a list too large to send whole", () => {
  // Nothing needs this today — Best Buy at 1,450 is the largest and still
  // fits — but it is one CSV update away, and the alternative when a list
  // does not fit is truncation, which hides the right answer.
  const bestbuy = categoryIndex("bestbuy")!;

  it("offers only real prefixes of real paths", () => {
    const top = nextSegments(bestbuy.paths);
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThan(bestbuy.paths.length);
    for (const t of top) {
      expect(bestbuy.paths.some((p) => p === t || p.startsWith(`${t} > `)), t).toBe(true);
    }
  });

  it("each level narrows to that branch only", () => {
    const [first] = nextSegments(bestbuy.paths);
    const second = nextSegments(bestbuy.paths, first);
    expect(second.length).toBeGreaterThan(0);
    for (const s of second) expect(categoryKey(s).startsWith(categoryKey(first))).toBe(true);
  });

  it("reaches every leaf if you keep drilling", () => {
    // The guarantee that matters: drilling can never strand a valid path.
    const paths = ["A > B > C", "A > B > D", "A > E", "F > G"];
    expect(nextSegments(paths)).toEqual(["A", "F"]);
    expect(nextSegments(paths, "A")).toEqual(["A > B", "A > E"]);
    expect(nextSegments(paths, "A > B")).toEqual(["A > B > C", "A > B > D"]);
    expect(nextSegments(paths, "a  >  b")).toEqual(["A > B > C", "A > B > D"]);
  });
});
