import { describe, expect, it } from "vitest";
import { MIN_SLICE_ESTIMATE_MS, nextSliceEstimateMs, roomForAnotherSlice, type SliceBudget } from "./slice-budget";

/**
 * The admission rule for one more slice.
 *
 * These are the numbers the export route runs with: a 300s invocation, a 210s
 * loop budget, 60s kept clear to assemble and store. The failure they exist to
 * prevent is not a slow export — it is an invocation killed at the ceiling,
 * which loses the group it was building and returns the client a timeout
 * instead of a result.
 */
const LIVE = {
  budgetMs: 210_000,
  invocationMs: 300_000,
  finishReserveMs: 60_000,
} as const;

/** The loop begins a little after the invocation does — auth, body, planGroups. */
function at(loopElapsed: number, longestSliceMs: number, preLoopMs = 4_000): SliceBudget {
  return {
    elapsedMs: loopElapsed,
    invocationElapsedMs: loopElapsed + preLoopMs,
    longestSliceMs,
    ...LIVE,
  };
}

describe("room for another slice", () => {
  it("keeps batching small groups", () => {
    // Twelve 6-second departments must not cost twelve requests.
    expect(roomForAnotherSlice(at(6_000, 6_000))).toBe(true);
    expect(roomForAnotherSlice(at(60_000, 6_000))).toBe(true);
    expect(roomForAnotherSlice(at(120_000, 6_000))).toBe(true);
  });

  it("refuses the slice that used to run through the ceiling", () => {
    // The exact failure. The old check asked whether the budget had been spent,
    // so at 209s with 210s of budget it said yes — and a group that takes 150s
    // ran to 359s inside a 300s invocation, losing everything it had built.
    expect(roomForAnotherSlice(at(209_000, 150_000))).toBe(false);
  });

  it("refuses a slice that fits the loop budget but not the invocation", () => {
    // The check the old code did not make. 100s into the loop with a 90s slice
    // is 190s against a 210s budget — permitted. But the invocation is already
    // at 160s, so 160 + 90 + 60 = 310s, past the 300s ceiling.
    const b = at(100_000, 90_000, 60_000);
    expect(b.elapsedMs + b.longestSliceMs).toBeLessThan(LIVE.budgetMs); // the loop says yes
    expect(roomForAnotherSlice(b)).toBe(false); // the invocation says no
  });

  it("leaves the finish reserve alone", () => {
    // A request that spends its last second on a slice has nothing assembled
    // to hand back, so the whole pass is wasted even though it did the work.
    const b = at(1_000, 15_000, 225_001);
    expect(roomForAnotherSlice(b)).toBe(false);
  });

  it("assumes a real slice before it has measured one", () => {
    // longestSliceMs is 0 on the first check. Trusting that would admit a
    // slice with no time at all left for it.
    expect(nextSliceEstimateMs(0)).toBe(MIN_SLICE_ESTIMATE_MS);
    expect(roomForAnotherSlice(at(205_000, 0))).toBe(false);
    expect(roomForAnotherSlice(at(10_000, 0))).toBe(true);
  });

  it("does not let one trivial group vouch for the next", () => {
    // Groups are planned largest-first, so a fast first slice is the weakest
    // possible evidence about the second.
    expect(nextSliceEstimateMs(200)).toBe(MIN_SLICE_ESTIMATE_MS);
  });

  it("carries the worst slice, not the last one", () => {
    // A 140s Furniture slice followed by a 3s Rugs slice must still be
    // budgeted as 140s — the next group could be another Furniture part.
    expect(roomForAnotherSlice(at(143_000, 140_000))).toBe(false);
    expect(roomForAnotherSlice(at(143_000, 3_000))).toBe(true);
  });

  it("still allows exactly one slice per request when forced to", () => {
    // The documented test hook: EXPORT_SLICE_BUDGET_MS=1 exercises the slicing
    // path on a small project. The loop always runs one group before asking,
    // so a budget of 1ms means one group per request — not zero.
    const oneMs = { ...at(500, 500), budgetMs: 1 };
    expect(roomForAnotherSlice(oneMs)).toBe(false);
  });

  it("never admits a slice it could not also finish", () => {
    // The property, over the whole space rather than the cases above.
    for (let loop = 0; loop <= 260_000; loop += 5_000) {
      for (const longest of [0, 3_000, 14_000, 60_000, 150_000]) {
        for (const pre of [0, 4_000, 40_000]) {
          const b = at(loop, longest, pre);
          if (!roomForAnotherSlice(b)) continue;
          const need = nextSliceEstimateMs(longest);
          expect(b.elapsedMs + need).toBeLessThanOrEqual(LIVE.budgetMs);
          expect(b.invocationElapsedMs + need + LIVE.finishReserveMs).toBeLessThanOrEqual(
            LIVE.invocationMs,
          );
        }
      }
    }
  });
});
