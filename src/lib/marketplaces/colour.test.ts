import { describe, it, expect } from "vitest";
import { extractColour } from "./verify";

describe("extractColour", () => {
  it("pulls a colour from a title", () => {
    expect(extractColour("Bon 01-222 Longsleeve Pocket T-Shirt Black")).toBe("black");
  });

  it("prefers an explicit colour attribute over the title", () => {
    // The marketplace publishes a colour field; it is authoritative.
    expect(
      extractColour("Some Widget Blue Edition", { color: "Red" }),
    ).toBe("red");
  });

  it("handles the British spelling of the attribute key", () => {
    expect(extractColour("Widget", { colour: "Green" })).toBe("green");
  });

  it("prefers multi-word colours over their single-word substrings", () => {
    expect(extractColour("Faucet in Rose Gold finish")).toBe("rose gold");
    expect(extractColour("Cabinet Off White shaker")).toBe("off white");
  });

  it("respects word boundaries", () => {
    // "redwood" must not register as "red"; "Reddish" likewise.
    expect(extractColour("Redwood Patio Table")).toBeNull();
  });

  it("does not treat a bare material word as a colour", () => {
    // "Steel" alone is a material, not a stated colour. Only the explicit
    // "stainless steel" finish term counts.
    expect(extractColour("Bon 11-174 Mortar Pan - Steel 29-inch")).toBeNull();
  });

  it("folds finish synonyms so the same shade compares equal", () => {
    // These were ~29 false 'differences' on a real 7k catalog.
    expect(extractColour("Convex Jointer - Stainless Steel"))
      .toBe(extractColour("Convex Jointer", { color: "Silver" }));
    expect(extractColour("Widget Gray")).toBe(extractColour("Widget Grey"));
    expect(extractColour("Widget", { color: "Chrome" })).toBe("silver");
  });

  it("treats Walmart's multi-color catch-all as not stated", () => {
    // It means "uncategorised", not a colour claim — comparing it produced a
    // large batch of false differences.
    expect(extractColour("Convex Jointer", { color: "Multi-Color" })).toBeNull();
    expect(extractColour("Widget", { color: "Assorted" })).toBeNull();
  });

  it("falls back to the title when the attribute is a catch-all", () => {
    expect(extractColour("Blue Widget Deluxe", { color: "Multi-Color" })).toBe("blue");
  });

  it("returns null for a plain product with no colour word", () => {
    expect(extractColour("Drill Mixer Double Blade 5-inch")).toBeNull();
  });

  it("keeps an unrecognised attribute value rather than dropping it", () => {
    // The marketplace's stated colour is still data, even if it isn't in our list.
    expect(extractColour("Widget", { color: "Seafoam Drift" })).toBe("seafoam drift");
  });

  it("ignores an empty attribute and falls back to text", () => {
    expect(extractColour("Widget Yellow", { color: "" })).toBe("yellow");
  });

  it("recognises wood-species finishes and folds them onto colour families", () => {
    // These were missing entirely — every "Oak Console Table" style title
    // reported "Not stated" (client-reported gap).
    expect(extractColour("Oak Console Table")).toBe("brown");
    expect(extractColour("Mahogany Bookshelf 5-Tier")).toBe("brown");
    expect(extractColour("Teak Patio Bench")).toBe("brown");
    expect(extractColour("Maple Cutting Board")).toBe("beige");
  });

  it("recognises the newly added decor shades", () => {
    expect(extractColour("Champagne Table Runner")).toBe("gold");
    expect(extractColour("Terracotta Plant Pot 8 inch")).toBe("orange");
    expect(extractColour("Plum Velvet Cushion")).toBe("purple");
    expect(extractColour("Widget", { color: "Rust" })).toBe("orange");
  });

  it("prefers the longest attribute match over an embedded shorter term", () => {
    expect(extractColour("Widget", { color: "Rosewood" })).toBe("brown");
  });
});
