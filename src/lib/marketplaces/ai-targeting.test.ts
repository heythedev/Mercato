import { describe, it, expect } from "vitest";

/**
 * The predicate used to select AI deep-check targets, mirrored from the route
 * and `applyAiVerificationPasses`. Both must keep "ok" products whose images
 * were never compared — otherwise the deep check silently skips exactly the
 * products it exists to resolve.
 */
type F = { field: string; note?: string };
const isTarget = (r: { status: string; fields: F[] }) =>
  r.status === "warning" ||
  r.status === "mismatch" ||
  r.fields.some((f) => f.field === "images" && f.note?.startsWith("Images not compared"));

const uncheckedImages: F = {
  field: "images",
  note: "Images not compared — run AI deep check to compare them visually.",
};

describe("AI deep-check targeting", () => {
  it("includes an ok product whose images were never compared", () => {
    // The regression: making unchecked images "ok" removed these products from
    // the AI pass, so clicking "AI deep check" did nothing for them.
    expect(isTarget({ status: "ok", fields: [uncheckedImages] })).toBe(true);
  });

  it("still includes flagged products", () => {
    expect(isTarget({ status: "warning", fields: [] })).toBe(true);
    expect(isTarget({ status: "mismatch", fields: [] })).toBe(true);
  });

  it("excludes an ok product whose images were already compared by AI", () => {
    // An AI verdict replaces the note, so it must not be re-examined.
    expect(
      isTarget({
        status: "ok",
        fields: [{ field: "images", note: "AI visual check: images match — same product." }],
      }),
    ).toBe(false);
  });

  it("excludes an ok product confirmed by UPC with no image comparison needed", () => {
    expect(
      isTarget({
        status: "ok",
        fields: [{ field: "images", note: "Product identity confirmed by exact UPC match — images not compared." }],
      }),
    ).toBe(false);
  });

  it("excludes an ok product with no images row at all", () => {
    expect(isTarget({ status: "ok", fields: [{ field: "title" }] })).toBe(false);
  });

  it("excludes not_found products", () => {
    expect(isTarget({ status: "not_found", fields: [] })).toBe(false);
  });
});
