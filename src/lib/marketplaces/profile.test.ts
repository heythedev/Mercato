import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROFILE,
  hasRequirementMatrix,
  profileFor,
  toTemplateCategoryPath,
} from "./profile";

// The point of the registry is that a marketplace nobody has declared still
// works, conservatively. Behaviour used to be `marketplace === "mathis"`
// comparisons spread across 86 files, so adding a marketplace meant finding
// every one and deciding whether it applied — and the ones nobody found were
// the bugs, because a new marketplace silently inherited whatever the `else`
// branch happened to do.

describe("a marketplace nobody has declared", () => {
  it("still gets a profile rather than throwing", () => {
    const p = profileFor("some_marketplace_added_next_year");
    expect(p.id).toBe("some_marketplace_added_next_year");
    expect(p.storedSeparator).toBe(DEFAULT_PROFILE.storedSeparator);
  });

  it("claims no capability its templates have not demonstrated", () => {
    // Off is the safe reading: a trait turned on asserts a sheet exists in a
    // file nobody has looked at, which is how a new marketplace ships broken.
    expect(hasRequirementMatrix("brand_new_marketplace")).toBe(false);
  });

  it("builds a category path with no invented root segment", () => {
    expect(toTemplateCategoryPath("brand_new_marketplace", "Furniture > Dining Room")).toBe(
      "Furniture/Dining Room",
    );
  });

  it("survives empty, blank and odd input", () => {
    expect(profileFor("").id).toBe("");
    expect(toTemplateCategoryPath("whatever", "")).toBe("");
    expect(toTemplateCategoryPath("whatever", "NoSeparators")).toBe("NoSeparators");
  });
});

describe("the declared marketplaces", () => {
  it("knows which templates carry a requirement matrix", () => {
    expect(hasRequirementMatrix("mathis")).toBe(true);
    expect(hasRequirementMatrix("bestbuy")).toBe(true);
    // Checked, not forgotten: these templates ship no Columns sheet, so there
    // is no per-category rule and the full column list is the right answer.
    expect(hasRequirementMatrix("walmart")).toBe(false);
    expect(hasRequirementMatrix("temu")).toBe(false);
    expect(hasRequirementMatrix("sears")).toBe(false);
  });

  it("applies the root segment a template's own vocabulary uses", () => {
    expect(toTemplateCategoryPath("mathis", "Furniture > Dining Room > Dining Chairs")).toBe(
      "Mathis Home/Furniture/Dining Room/Dining Chairs",
    );
    // Best Buy's matrix paths carry no root.
    expect(toTemplateCategoryPath("bestbuy", "Appliances > Microwaves")).toBe(
      "Appliances/Microwaves",
    );
  });

  it("leaves a value already in template form untouched", () => {
    const already = "Mathis Home/Furniture/Dining Room";
    expect(toTemplateCategoryPath("mathis", already)).toBe(already);
  });

  it("folds the stored variants that mean one marketplace", () => {
    // Projects store "amazon_us"; access control and behaviour both mean
    // "amazon". A profile lookup that missed this would hand a known
    // marketplace the undeclared default.
    expect(profileFor("amazon_us").id).toBe("amazon");
    expect(profileFor("AMAZON").id).toBe("amazon");
    expect(profileFor("Best Buy").id).toBe("bestbuy");
    expect(profileFor("  Mathis  ").id).toBe("mathis");
    expect(hasRequirementMatrix("Best Buy")).toBe(true);
  });
});
