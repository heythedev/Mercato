import { describe, it, expect, vi } from "vitest";

// job-store talks to the database; nothing under test here does.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { toUnfilledReport } from "./job-store";

describe("reading an export's unfilled-column report", () => {
  it("keeps the columns and the AI verdict", () => {
    expect(
      toUnfilledReport({ columns: [{ label: "Prop 65", rows: 41 }], aiUnavailable: false }),
    ).toEqual({ columns: [{ label: "Prop 65", rows: 41 }], aiUnavailable: false, recorded: true });
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
      expect(toUnfilledReport(junk)).toEqual({ columns: [], aiUnavailable: false, recorded: false });
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
