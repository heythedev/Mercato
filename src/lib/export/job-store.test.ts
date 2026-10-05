import { describe, it, expect, vi } from "vitest";

// job-store talks to the database; nothing under test here does.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { mergeSliceOutcome, toUnfilledReport, type UnfilledReport } from "./job-store";

describe("reading an export's unfilled-column report", () => {
  it("keeps the columns and the AI verdict", () => {
    expect(
      toUnfilledReport({ columns: [{ label: "Prop 65", rows: 41 }], aiUnavailable: false }),
    ).toEqual({ columns: [{ label: "Prop 65", rows: 41 }], aiUnavailable: false, recorded: true, dropdowns: {} });
  });

  it("marks a bare array as carrying no verdict", () => {
    // Jobs written before the flag existed stored just the array, and there is
    // no way to tell afterwards whether their AI was working. The columns stay
    // readable, but recorded:false stops anything CONCLUDING from them — the
    // suggestion list would otherwise offer a fixed value for Material or Wood
    // Type, which vary per product.
    expect(toUnfilledReport([{ label: "PFAS", rows: 23 }])).toEqual({
      columns: [{ label: "PFAS", rows: 23 }],
      aiUnavailable: false,
      // No verdict was stored, so nothing may CONCLUDE from these empty cells.
      recorded: false,
    });
  });

  it("survives null, undefined and junk without throwing", () => {
    // This value comes out of a JSONB column, so it is whatever was written —
    // a poll that throws here would break the export screen after a successful run.
    for (const junk of [null, undefined, 0, "", "nonsense", true]) {
      expect(toUnfilledReport(junk)).toEqual({ columns: [], aiUnavailable: false, recorded: false, dropdowns: {} });
    }
  });

  it("never reports aiUnavailable as true unless it was actually recorded", () => {
    // The flag suppresses the "set a default" inputs. Defaulting it ON would
    // silently disable the feature; defaulting it OFF only risks offering a
    // default that an admin still has to type and confirm.
    expect(toUnfilledReport({ columns: [] }).aiUnavailable).toBe(false);
    expect(toUnfilledReport({ columns: [], aiUnavailable: true }).aiUnavailable).toBe(true);
  });
});

/**
 * Accumulating a sliced export's findings across the requests that built it.
 *
 * A large export is built a slice at a time and takes several requests. The
 * findings used to live in locals inside the POST handler, so a job reported
 * only what its FINAL request happened to see — and the two things being
 * reported are exactly the ones a large export exists to tell you: which
 * categories still need a template, and which required columns shipped empty.
 */
const EMPTY = {
  missingTemplateCategories: [] as string[],
  unfilledRequired: { columns: [], aiUnavailable: false, recorded: true } as UnfilledReport,
};

describe("folding slice findings into the job", () => {
  it("keeps a category found by an EARLY request", () => {
    // The bug, stated as a test. Best Buy publishes no bulk template, so this
    // list is the instruction for which workbooks to fetch from the portal.
    // Reporting only the last request's findings sent people looking for
    // nothing while ten categories were still uncovered.
    const first = mergeSliceOutcome(EMPTY, {
      missingTemplateCategories: ["Seasonal Decorations", "Luggage Racks"],
      unfilled: [],
      aiUnavailable: false,
    });
    const second = mergeSliceOutcome(first, {
      missingTemplateCategories: [],
      unfilled: [],
      aiUnavailable: false,
    });
    expect(second.missingTemplateCategories).toEqual(["Luggage Racks", "Seasonal Decorations"]);
  });

  it("names a category once however many slices hit it", () => {
    const a = mergeSliceOutcome(EMPTY, {
      missingTemplateCategories: ["Dining Tables"],
      unfilled: [],
      aiUnavailable: false,
    });
    const b = mergeSliceOutcome(a, {
      missingTemplateCategories: ["Dining Tables", "Dressers"],
      unfilled: [],
      aiUnavailable: false,
    });
    expect(b.missingTemplateCategories).toEqual(["Dining Tables", "Dressers"]);
  });

  it("sums a column's rows rather than keeping the last slice's count", () => {
    // Each slice counts only its own rows. "Prop 65 empty on 41 rows" when the
    // export left 1,200 empty is worse than no number at all.
    let acc = EMPTY;
    for (const rows of [41, 380, 779]) {
      acc = mergeSliceOutcome(acc, {
        missingTemplateCategories: [],
        unfilled: [{ label: "Prop 65", rows }],
        aiUnavailable: false,
      });
    }
    expect(acc.unfilledRequired.columns).toEqual([{ label: "Prop 65", rows: 1200 }]);
  });

  it("orders columns worst-first", () => {
    const acc = mergeSliceOutcome(EMPTY, {
      missingTemplateCategories: [],
      unfilled: [{ label: "Finish", rows: 12 }, { label: "Prop 65", rows: 900 }],
      aiUnavailable: false,
    });
    expect(acc.unfilledRequired.columns.map((c) => c.label)).toEqual(["Prop 65", "Finish"]);
  });

  it("an AI outage in ANY slice taints the whole report", () => {
    // The dangerous direction. If the AI was down for one slice, that slice's
    // empty cells are not evidence the column is unanswerable — and the export
    // screen would otherwise offer a fixed default for a per-product attribute
    // like Finish Color, writing one wrong value into every future row.
    const a = mergeSliceOutcome(EMPTY, {
      missingTemplateCategories: [],
      unfilled: [{ label: "Finish Color", rows: 600 }],
      aiUnavailable: true,
    });
    const b = mergeSliceOutcome(a, {
      missingTemplateCategories: [],
      unfilled: [],
      aiUnavailable: false,
    });
    expect(b.unfilledRequired.aiUnavailable).toBe(true);
  });

  it("marks the result as a recorded verdict", () => {
    // recorded:false means "no verdict was stored", which suppresses every
    // conclusion drawn from empty cells. A merged report HAS a verdict.
    const acc = mergeSliceOutcome(EMPTY, {
      missingTemplateCategories: [],
      unfilled: [],
      aiUnavailable: false,
    });
    expect(acc.unfilledRequired.recorded).toBe(true);
  });

  it("starts cleanly from a job row that has never been written to", () => {
    // The first slice of a job merges onto whatever the column holds, which is
    // null until then — toUnfilledReport turns that into an empty report.
    const fresh = {
      missingTemplateCategories: [],
      unfilledRequired: toUnfilledReport(null),
    };
    const acc = mergeSliceOutcome(fresh, {
      missingTemplateCategories: ["Rugs"],
      unfilled: [{ label: "PFAS", rows: 3 }],
      aiUnavailable: false,
    });
    expect(acc.missingTemplateCategories).toEqual(["Rugs"]);
    expect(acc.unfilledRequired.columns).toEqual([{ label: "PFAS", rows: 3 }]);
  });
});
