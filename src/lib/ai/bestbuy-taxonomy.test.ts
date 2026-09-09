import { describe, expect, it } from "vitest";
import { loadBestBuyCategoryPaths, bestBuyCodeForPath, formatBestBuyTaxonomyForPrompt } from "./bestbuy-taxonomy";
import { hierarchiesToLeafPaths } from "@/lib/bestbuy/mirakl-client";

// Best Buy's real tree (Mirakl H11) is 4 levels and RAGGED: leaves sit at
// depth 2, 3 AND 4. The previous parser required exactly three non-empty
// columns, which dropped every non-depth-3 leaf — the taxonomy the model was
// choosing from covered a fraction of the real one.
describe("bestbuy taxonomy (real Mirakl tree)", () => {
  const paths = loadBestBuyCategoryPaths();

  it("loads the full leaf set, not just depth-3 rows", () => {
    expect(paths.length).toBeGreaterThan(1000);
    const depths = new Set(paths.map((p) => p.split(" > ").length));
    // Ragged by nature — if this collapses to a single depth the parser has
    // regressed to the old three-column assumption.
    expect(depths.size).toBeGreaterThan(1);
    expect([...depths].some((d) => d === 4)).toBe(true);
  });

  it("keeps every path fully qualified from its top-level category", () => {
    for (const p of paths.slice(0, 200)) {
      expect(p).not.toMatch(/^\s|\s$/);
      expect(p.split(" > ").every((seg) => seg.length > 0)).toBe(true);
    }
  });

  it("resolves a path back to its Mirakl hierarchy code", () => {
    // The code, not the label, is what PM11 and Mirakl's product import key on.
    const code = bestBuyCodeForPath(paths[0]!);
    expect(code).toBeTruthy();
    expect(code).not.toContain(" > ");
  });

  it("builds a prompt block covering every top-level category", () => {
    const block = formatBestBuyTaxonomyForPrompt();
    const tops = new Set(paths.map((p) => p.split(" > ")[0]!));
    for (const t of tops) expect(block).toContain(t);
  });
});

describe("hierarchiesToLeafPaths", () => {
  it("treats any node without children as a leaf, at whatever depth", () => {
    const nodes = [
      { code: "A", label: "Auto", level: 1 },
      { code: "B", label: "Audio", level: 2, parent_code: "A" },
      { code: "C", label: "Amps", level: 3, parent_code: "B" },
      { code: "D", label: "Shallow", level: 2, parent_code: "A" }, // leaf at depth 2
    ];
    const leaves = hierarchiesToLeafPaths(nodes);
    expect(leaves.map((l) => l.path).sort()).toEqual(["Auto > Audio > Amps", "Auto > Shallow"]);
  });

  it("does not hang on a parent cycle in the source data", () => {
    const nodes = [
      { code: "X", label: "X", level: 1, parent_code: "Y" },
      { code: "Y", label: "Y", level: 1, parent_code: "X" },
    ];
    expect(() => hierarchiesToLeafPaths(nodes)).not.toThrow();
  });
});
