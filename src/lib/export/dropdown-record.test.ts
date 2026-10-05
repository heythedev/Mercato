import { describe, expect, it } from "vitest";
import { mergeSliceOutcome, toUnfilledReport } from "./job-store";

// A dropdown-constrained column accepts one of its own options verbatim and
// nothing else. Before these, next_export_gaps named such a column but not its
// options, so an answer was written blind — and the export then either dropped
// it or, through word overlap, substituted the nearest option. That is how a
// parrot "Play Stand" reached the file as "Play Pen": nobody was told.
//
// The options are RECORDED BY THE EXPORT rather than re-derived, so what a
// caller is offered is exactly what that export would take.

describe("dropdown options recorded on the job", () => {
  it("survives a round trip through the job record", () => {
    const report = toUnfilledReport({
      columns: [{ label: "Play Furniture Type", rows: 3 }],
      aiUnavailable: true,
      dropdowns: { "Play Furniture Type": ["Play Kitchen", "Rockers", "Dollhouse"] },
    });
    expect(report.dropdowns?.["Play Furniture Type"]).toEqual([
      "Play Kitchen",
      "Rockers",
      "Dollhouse",
    ]);
  });

  it("defaults to empty for an export that recorded none", () => {
    // Jobs finished before this shipped carry no options. The caller must see
    // an absence, not an empty list that reads as "this column allows nothing".
    expect(toUnfilledReport({ columns: [], aiUnavailable: false }).dropdowns).toEqual({});
    expect(toUnfilledReport(null).dropdowns).toEqual({});
  });

  it("unions the options across slices", () => {
    // Each slice sees only the templates its own categories use, so a column's
    // options arrive with whichever slice happened to carry it. A later slice
    // must not erase what an earlier one recorded.
    const first = mergeSliceOutcome(
      { missingTemplateCategories: [], unfilledRequired: toUnfilledReport(null) },
      {
        missingTemplateCategories: [],
        unfilled: [{ label: "Wood Type", rows: 2 }],
        aiUnavailable: false,
        dropdowns: { "Wood Type": ["Oak", "Pine"] },
      },
    );
    const second = mergeSliceOutcome(first, {
      missingTemplateCategories: [],
      unfilled: [{ label: "Bed Size", rows: 1 }],
      aiUnavailable: false,
      dropdowns: { "Bed Size": ["Twin", "Queen"] },
    });

    expect(Object.keys(second.unfilledRequired.dropdowns ?? {}).sort()).toEqual([
      "Bed Size",
      "Wood Type",
    ]);
    expect(second.unfilledRequired.dropdowns?.["Wood Type"]).toEqual(["Oak", "Pine"]);
  });

  it("keeps what was already recorded when a later slice repeats a column", () => {
    const first = mergeSliceOutcome(
      { missingTemplateCategories: [], unfilledRequired: toUnfilledReport(null) },
      {
        missingTemplateCategories: [],
        unfilled: [],
        aiUnavailable: false,
        dropdowns: { Color: ["Red", "Blue"] },
      },
    );
    const second = mergeSliceOutcome(first, {
      missingTemplateCategories: [],
      unfilled: [],
      aiUnavailable: false,
      dropdowns: { Color: ["Red", "Blue", "Green"] },
    });
    // The same column cannot hold two lists; first writer wins rather than the
    // merge inventing a union of two templates' vocabularies.
    expect(second.unfilledRequired.dropdowns?.Color).toEqual(["Red", "Blue"]);
  });
});

describe("the near-miss that must be refused", () => {
  // submit_export_values compares with this collapse and nothing looser. The
  // export's own second pass scores whole-word overlap, which is exactly what
  // turned "Play Stand" into "Play Pen"; accepting on that basis here would
  // reintroduce the bug one layer earlier.
  const collapse = (x: string) =>
    x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

  const OPTIONS = ["Play Kitchen", "Play Pen", "Baby Activity Gym", "Rockers", "Dollhouse"];
  const accepts = (value: string) => OPTIONS.find((o) => collapse(o) === collapse(value)) ?? null;

  it("refuses a value that merely shares a word with an option", () => {
    expect(accepts("Play Stand")).toBeNull();
  });

  it("accepts an exact option, and canonicalises punctuation and case", () => {
    expect(accepts("Play Pen")).toBe("Play Pen");
    expect(accepts("play pen")).toBe("Play Pen");
    expect(accepts("Play-Pen")).toBe("Play Pen");
    expect(accepts("BABY ACTIVITY GYM")).toBe("Baby Activity Gym");
  });

  it("refuses the other values the live run lost", () => {
    // Real answers from the Baby & Kids run: sensible readings of the product
    // that no option matches. Refused with the list, rather than stored and
    // silently dropped on the way into the file.
    for (const v of ["Desk", "Cabinet", "Twill", "Microsuede"]) {
      expect(accepts(v)).toBeNull();
    }
  });
});
