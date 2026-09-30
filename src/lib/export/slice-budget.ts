/**
 * Whether there is room to start ANOTHER slice, or whether this request should
 * hand the rest to the next one.
 *
 * The rule lived inline in the export route, which meant the fix for the
 * Mathis export — the one that kept dying at FUNCTION_INVOCATION_TIMEOUT with
 * nothing to show for 4.7 minutes — could only be checked by running a
 * 4,811-product catalogue against a funded AI account. It is arithmetic, so it
 * belongs somewhere it can be checked directly.
 *
 * Two deadlines apply and the stricter one wins.
 *
 *  1. The LOOP budget. A request stops slicing before its own ceiling so it
 *     can write what it built and tell the client what is left.
 *
 *  2. The INVOCATION ceiling. This is the one the old check missed: it
 *     measured only from the point the loop began, so everything before it —
 *     auth, reading the body, the groupBy that plans the groups, creating the
 *     job row — was free. On a large catalogue that is seconds, and seconds
 *     are exactly what stood between a slice finishing and being killed at
 *     300s with its work discarded.
 *
 * Both ask the same question: not "has the budget been spent" but "is there
 * room for another slice the size of the biggest one so far". Asking the first
 * question is what allowed a group to START at 209s and run for another 150,
 * straight through the ceiling.
 */

/**
 * What a slice is assumed to cost before one has been measured, and the floor
 * under every later estimate.
 *
 * A slice loads its products, enriches them, fills the template and writes the
 * file. Fifteen seconds is quick for that. The floor matters because the
 * groups are planned largest-first: if the first one happens to be trivial,
 * trusting its duration to predict the next would be exactly backwards.
 */
export const MIN_SLICE_ESTIMATE_MS = 15_000;

export interface SliceBudget {
  /** Time since the slicing loop began. */
  elapsedMs: number;
  /** Time since the invocation began. Never less than `elapsedMs`. */
  invocationElapsedMs: number;
  /** The longest slice this request has run. 0 before any has finished. */
  longestSliceMs: number;
  /** The loop's own ceiling, short of the invocation's. */
  budgetMs: number;
  /** The platform's hard limit for this request. */
  invocationMs: number;
  /** Kept clear at the end to assemble and store what was built. */
  finishReserveMs: number;
}

/**
 * How long the next slice should be assumed to take.
 * Exported because a caller that logs its decision should log this too.
 */
export function nextSliceEstimateMs(longestSliceMs: number): number {
  return Math.max(longestSliceMs, MIN_SLICE_ESTIMATE_MS);
}

/** True when another slice can be started AND finished in the time that is left. */
export function roomForAnotherSlice(b: SliceBudget): boolean {
  const need = nextSliceEstimateMs(b.longestSliceMs);
  if (b.elapsedMs + need > b.budgetMs) return false;
  if (b.invocationElapsedMs + need + b.finishReserveMs > b.invocationMs) return false;
  return true;
}
