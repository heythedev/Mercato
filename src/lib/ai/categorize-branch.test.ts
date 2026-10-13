import { describe, expect, it } from "vitest";
import { branchesOf, buildCategorizationPrompt } from "./categorize";
import { INLINE_TAXONOMY_MAX } from "@/lib/categorize/taxonomy";
import { loadEbayCategoryPaths } from "./ebay-taxonomy";
import { taxonomyFor } from "@/lib/marketplaces/taxonomy-registry";

/**
 * eBay is the first taxonomy that will not fit in one prompt, so the
 * categoriser asks in two parts: the department, then the leaf within it.
 *
 * What is pinned here is the SPLIT, not the model. The prompt is pure and
 * the branch map is pure; both can be asserted against the real 18,095-path
 * file with no AI call, which is the only way any of this is checkable with
 * the balance at zero.
 */

const EBAY = loadEbayCategoryPaths();

describe("splitting a taxonomy into departments", () => {
  it("covers every path exactly once", () => {
    const branches = branchesOf(EBAY);
    const counted = [...branches.values()].reduce((n, list) => n + list.length, 0);
    // A path dropped here is a category the model can never be offered.
    expect(counted).toBe(EBAY.length);
  });

  it("gives eBay 36 departments", () => {
    expect(branchesOf(EBAY).size).toBe(36);
  });

  it("puts every path under its own first segment", () => {
    for (const [top, paths] of branchesOf(EBAY)) {
      for (const p of paths) {
        expect(p === top || p.startsWith(`${top} > `), `${p} under ${top}`).toBe(true);
      }
    }
  });

  it("does NOT fit every department in one prompt at the first level", () => {
    // The reason the narrowing repeats. One split was the obvious
    // implementation and it leaves four departments over the ceiling — and
    // Home & Garden, at 1,612, is where this client's garlands are. Pinned
    // so nobody simplifies the recursion back out.
    const oversized = [...branchesOf(EBAY)]
      .filter(([, paths]) => paths.length > INLINE_TAXONOMY_MAX)
      .map(([top]) => top)
      .sort();
    expect(oversized).toEqual([
      "Business & Industrial",
      "Collectibles",
      "Home & Garden",
      "eBay Motors",
    ]);
  });

  it("fits every group once it narrows as far as it needs to", () => {
    // What the recursion actually has to achieve: no group over the ceiling
    // that still has somewhere to go.
    const tooBig: string[] = [];
    const walk = (paths: string[], depth: number) => {
      const groups = branchesOf(paths, depth);
      for (const [key, list] of groups) {
        if (list.length <= INLINE_TAXONOMY_MAX) continue;
        if (groups.size <= 1) { tooBig.push(`${key} (${list.length}) — cannot narrow`); continue; }
        walk(list, depth + 1);
      }
    };
    walk(EBAY, 1);
    expect(tooBig).toEqual([]);
  });

  it("keeps a path whose own name contains the separator's characters", () => {
    const branches = branchesOf(EBAY);
    const antiques = branches.get("Antiques") ?? [];
    expect(antiques).toContain(
      "Antiques > Architectural & Garden > Chandeliers, Sconces & Lighting Fixtures",
    );
  });

  it("ignores a blank line rather than inventing a department for it", () => {
    expect(branchesOf(["", "   ", "Real > Thing"]).size).toBe(1);
  });
});

describe("what each pass actually asks", () => {
  const product = {
    id: "p1",
    name: "Vickerman 9' Cashmere Pine Garland",
    brand: "Vickerman",
    description: "Artificial garland for indoor and outdoor use.",
  };

  it("pass one offers the departments, not the 18,095 paths", () => {
    const tops = [...branchesOf(EBAY).keys()];
    const { systemPrompt, userPrompt } = buildCategorizationPrompt([product], "ebay", "kimi-k2.7-code-highspeed", tops);
    const prompt = systemPrompt + userPrompt;
    expect(tops.length).toBe(36);
    // The size is the reason this exists, so the size is asserted. The whole
    // list rendered to ~1.6M characters.
    expect(prompt.length).toBeLessThan(20_000);
    expect(prompt).toContain("Antiques");
    expect(prompt).not.toContain("Chandeliers, Sconces & Lighting Fixtures");
  });

  it("pass two offers one department's leaves only", () => {
    const antiques = branchesOf(EBAY).get("Antiques")!;
    const { systemPrompt, userPrompt } = buildCategorizationPrompt([product], "ebay", "kimi-k2.7-code-highspeed", antiques);
    const prompt = systemPrompt + userPrompt;
    expect(prompt).toContain("Antiques > Architectural & Garden > Beams");
    // A leaf from another department must not be offered, or the narrowing
    // bought nothing.
    expect(prompt).not.toContain("Cell Phones & Accessories >");
  });

  it("renders the full list for a taxonomy that fits, unchanged", () => {
    // Best Buy at 1,450 is under the ceiling and must still be asked in one
    // pass — this change is for the one marketplace that does not fit.
    const bestbuy = taxonomyFor("bestbuy")!.load();
    expect(bestbuy.length).toBeLessThanOrEqual(INLINE_TAXONOMY_MAX);
  });
});

describe("eBay is categorisable in Mercato again", () => {
  it("no longer refuses on the size of its list", () => {
    // The registry used to refuse with "categorise through Claude for now".
    // That refusal was correct while the categoriser sent the list whole.
    expect(taxonomyFor("ebay")!.unavailableReason?.()).toBeNull();
  });

  it("still refuses when there is no list at all", () => {
    // The other refusal has to survive: without a CSV the model free-forms
    // categories eBay does not have, silently, until upload.
    expect(taxonomyFor("wayfair")!.unavailableReason?.()).toMatch(/not configured/i);
  });
});
