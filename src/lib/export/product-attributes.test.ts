import { describe, expect, it } from "vitest";
import { storedAttribute } from "./product-attributes";
import { defaultKey } from "./defaults";

const attrs = (pairs: [string, string][]) =>
  new Map(pairs.map(([k, v]) => [defaultKey(k), v]));

describe("stored product attributes", () => {
  it("answers a column by the attribute code it was stored under", () => {
    const a = attrs([["material", "Cotton"]]);
    expect(storedAttribute(a, "material")).toBe("Cotton");
  });

  it("answers the same column when the template prefixes it with a category", () => {
    // The value is a fact about the product, so it must survive being asked for
    // under a different category's spelling on a later export.
    const a = attrs([["material", "Cotton"]]);
    expect(storedAttribute(a, "Jackets.material")).toBe("Cotton");
  });

  it("answers by header label when the template has no code row", () => {
    const a = attrs([["Feature Bullets: 1: Title", "Fits most standard frames"]]);
    expect(storedAttribute(a, "unmatched.code", "Feature Bullets: 1: Title")).toBe(
      "Fits most standard frames",
    );
  });

  it("returns empty for a product with nothing stored", () => {
    expect(storedAttribute(undefined, "material")).toBe("");
    expect(storedAttribute(new Map(), "material")).toBe("");
  });

  it("does not answer a different attribute", () => {
    const a = attrs([["material", "Cotton"]]);
    expect(storedAttribute(a, "Jackets.jacketStyle")).toBe("");
  });
});
