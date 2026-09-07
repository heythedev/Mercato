import { describe, it, expect } from "vitest";
import { groupByKey, isImageCheckPending, needsImageRequeue, requeueImageField, hasComparablePair } from "./image-check-state";

describe("groupByKey", () => {
  it("keeps a singleton item in its own group", () => {
    expect(groupByKey([{ id: "a" }], (x) => x.id)).toEqual([[{ id: "a" }]]);
  });

  it("groups items sharing a key together, preserving first-seen order", () => {
    const items = [
      { id: "a", k: "x" },
      { id: "b", k: "y" },
      { id: "c", k: "x" },
      { id: "d", k: "x" },
    ];
    expect(groupByKey(items, (i) => i.k)).toEqual([
      [items[0], items[2], items[3]],
      [items[1]],
    ]);
  });

  it("returns one group per item when every key is distinct", () => {
    const items = [{ k: "1" }, { k: "2" }, { k: "3" }];
    expect(groupByKey(items, (i) => i.k)).toEqual([[items[0]], [items[1]], [items[2]]]);
  });

  it("handles an empty list", () => {
    expect(groupByKey([], () => "k")).toEqual([]);
  });
});

// Sanity checks that the pre-existing predicates this session's other new
// code (the sweep route) relies on still behave as documented.
describe("image-check-state predicates (regression guard)", () => {
  const base = { field: "images", stored: "https://v/cat.jpg", liveImage: "https://m/live.jpg" };

  it("hasComparablePair requires both URLs", () => {
    expect(hasComparablePair(base)).toBe(true);
    expect(hasComparablePair({ ...base, liveImage: undefined })).toBe(false);
  });

  it("isImageCheckPending / needsImageRequeue keep their documented behavior", () => {
    expect(isImageCheckPending({ ...base, note: "not compared" })).toBe(true);
    expect(needsImageRequeue({ ...base, note: "AI visual check: images match" })).toBe(false);
    const requeued = { ...base, note: "Needs manual review — AI vision call failed" };
    requeueImageField(requeued);
    expect(requeued.note).toMatch(/^Images not compared yet/);
  });
});
