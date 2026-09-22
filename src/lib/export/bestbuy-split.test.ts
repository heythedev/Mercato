import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { mergeZips, normCategoryPath, splitBestBuyByTemplate } from "./zip";

describe("comparing category paths", () => {
  it("treats the two separators Best Buy sheets use as the same", () => {
    expect(normCategoryPath("Home and Garden / Decor / Wall Art")).toBe(
      normCategoryPath("Home and Garden > Decor > Wall Art"),
    );
  });

  it("ignores case and stray spacing around the separators", () => {
    expect(normCategoryPath("  Home And Garden  >  Decor  ")).toBe("home and garden > decor");
  });

  it("is empty for a missing path, so nothing accidentally matches nothing", () => {
    // An empty declared category must never count as covering a product whose
    // own category is also blank — that would route uncategorised rows into
    // whichever template happened to have no category set.
    expect(normCategoryPath("")).toBe("");
    expect(normCategoryPath(null as unknown as string)).toBe("");
  });
});

describe("splitting a Best Buy catalogue by template coverage", () => {
  const products = [
    { id: "1", marketplaceCategory: "Home and Garden > Decor > Wall Art" },
    { id: "2", marketplaceCategory: "Home and Garden > Decor > Wall Art" },
    { id: "3", marketplaceCategory: "Major Appliances > Kitchen > Ranges" },
    { id: "4", marketplaceCategory: "Uncategorized" },
    { id: "5", marketplaceCategory: null },
  ];

  it("routes only the categories a template actually declares", () => {
    const templates = [{ category: "Home and Garden > Decor > Wall Art" }];
    const out = splitBestBuyByTemplate(products, templates);

    expect(out.covered.map((p) => p.id)).toEqual(["1", "2"]);
    expect(out.uncovered.map((p) => p.id)).toEqual(["3", "4", "5"]);
    expect(out.coveredCategories).toEqual(["Home and Garden > Decor > Wall Art"]);
  });

  it("matches across separator and case differences", () => {
    // The seller types the category when uploading; Mirakl writes it with " > ".
    const templates = [{ category: "home and garden / decor / wall art" }];
    expect(splitBestBuyByTemplate(products, templates).covered).toHaveLength(2);
  });

  it("keeps uncategorised rows out of the covered half", () => {
    // They have no category to match, and the generated path already sends them
    // to Uncategorized.csv. Letting them fall into a template would write rows
    // into a workbook whose columns were never meant for them.
    const templates = [{ category: "Home and Garden > Decor > Wall Art" }];
    const out = splitBestBuyByTemplate(products, templates);
    expect(out.uncovered.map((p) => p.id)).toContain("4");
    expect(out.uncovered.map((p) => p.id)).toContain("5");
    expect(out.uncoveredCategories).not.toContain("Uncategorized");
  });

  it("puts everything in the uncovered half when no template declares a category", () => {
    // This is the state a fresh Best Buy project is in, and it must still
    // export — via the Mirakl-generated sheets — rather than produce nothing.
    const out = splitBestBuyByTemplate(products, [{ category: null }, { category: "" }]);
    expect(out.covered).toHaveLength(0);
    expect(out.uncovered).toHaveLength(5);
  });

  it("reports each uncovered category once, however many products it has", () => {
    const out = splitBestBuyByTemplate(products, []);
    expect(out.uncoveredCategories).toEqual([
      "Home and Garden > Decor > Wall Art",
      "Major Appliances > Kitchen > Ranges",
    ]);
  });
});

describe("merging the two halves into one download", () => {
  async function zipOf(files: Record<string, string>): Promise<Buffer> {
    const z = new JSZip();
    for (const [name, body] of Object.entries(files)) z.file(name, body);
    return (await z.generateAsync({ type: "nodebuffer" })) as unknown as Buffer;
  }

  it("returns the single part untouched when there is only one", async () => {
    const only = await zipOf({ "a.xlsx": "A" });
    expect(await mergeZips([only])).toBe(only);
  });

  it("carries every entry from every part", async () => {
    const merged = await mergeZips([
      await zipOf({ "Wall Art.xlsx": "A" }),
      await zipOf({ "Ranges.xlsx": "B", "Uncategorized.csv": "C" }),
    ]);
    const out = await JSZip.loadAsync(merged);
    expect(Object.keys(out.files).sort()).toEqual([
      "Ranges.xlsx",
      "Uncategorized.csv",
      "Wall Art.xlsx",
    ]);
    expect(await out.file("Wall Art.xlsx")!.async("string")).toBe("A");
  });

  it("suffixes a collision instead of dropping one of the two files", async () => {
    // Both halves can legitimately produce a file for the same category name.
    // Overwriting would silently lose a sheet full of the seller's rows.
    const merged = await mergeZips([
      await zipOf({ "Wall Art.xlsx": "from template" }),
      await zipOf({ "Wall Art.xlsx": "from mirakl" }),
    ]);
    const out = await JSZip.loadAsync(merged);
    expect(Object.keys(out.files).sort()).toEqual(["Wall Art (2).xlsx", "Wall Art.xlsx"]);
    expect(await out.file("Wall Art.xlsx")!.async("string")).toBe("from template");
    expect(await out.file("Wall Art (2).xlsx")!.async("string")).toBe("from mirakl");
  });
});
