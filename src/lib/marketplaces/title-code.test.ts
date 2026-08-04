import { describe, it, expect } from "vitest";
import { titleCodeConflict } from "./verify";

describe("titleCodeConflict", () => {
  it("flags different model codes in the same family", () => {
    // The real case: a Flat Slicker matched to an English Plugging Chisel.
    expect(
      titleCodeConflict(
        "Bon 11-482 Flat Slicker - Double 1 4-inch X 3 8-inch",
        "Bon 11-385 English Plugging Chisel - 1/4-inch X 10-inch",
      ),
    ).toEqual({ vendor: "11-482", live: "11-385" });
  });

  it("flags the mortar box size confusion", () => {
    expect(
      titleCodeConflict(
        "Bon 11-303 Mortar Box - Steel 8.4 Cubic Feet",
        "Bon Tool 11-304 Mortar Box - Steel 4.5 Cu Ft",
      ),
    ).toEqual({ vendor: "11-303", live: "11-304" });
  });

  it("does NOT flag when the codes match exactly", () => {
    expect(
      titleCodeConflict(
        "Bon 11-174 Mortar Pan - Steel",
        "Bon Tool 11-174 Mortar Pan - Steel 29 In.",
      ),
    ).toBeNull();
  });

  it("does NOT flag across different families", () => {
    // 11-* vs 21-* are unrelated codes; nothing to compare, so stay silent and
    // let normal similarity scoring decide.
    expect(
      titleCodeConflict("Bon 11-482 Flat Slicker", "Bon 21-304 Caulking Trowel"),
    ).toBeNull();
  });

  it("does NOT flag when either title has no code", () => {
    expect(titleCodeConflict("Flat Slicker Double", "Bon 11-385 Chisel")).toBeNull();
    expect(titleCodeConflict("Bon 11-482 Flat Slicker", "English Plugging Chisel")).toBeNull();
  });

  it("ignores fractions and small dimension ranges", () => {
    // "1-4" / "3-8" are fractions, not model codes: too few digits to qualify.
    expect(
      titleCodeConflict(
        "Chisel - 1-4 inch X 3-8 inch",
        "Chisel - 1-4 inch X 5-8 inch",
      ),
    ).toBeNull();
  });

  it("finds an exact match even when other codes differ", () => {
    // A shared 11-174 proves identity; a second differing pair must not override it.
    expect(
      titleCodeConflict(
        "Bon 11-174 Pan 29-inch",
        "Bon Tool 11-174 Pan 30-inch",
      ),
    ).toBeNull();
  });
});
