"use client";

import { runVerifyHeadless, type RunStatus } from "@/lib/client/headless-verify";
import { runCategorizeHeadless, type CategorizeStatus } from "@/lib/client/headless-categorize";

// Multi-project Run Queue: lets a user start Verify or Categorize on several
// projects from one screen (the projects list) and let them run without
// keeping each project's own page open. Steps stay manual — this only lets
// MORE THAN ONE already-manual action be in flight at once, in one tab.
//
// A plain module-level store (not React state) so the actual scheduling logic
// is synchronous, ordinary JS with no dependency on React's render/effect
// timing — a background task manager is exactly the kind of thing that gets
// subtly wrong (double-starts, stale closures) when built as a useEffect
// chain. The UI subscribes via useSyncExternalStore (see the hook at the
// bottom) and only re-renders when something actually changes.
//
// Scheduling policy: click order (FIFO), up to MAX_ACTIVE projects running at
// once; the rest wait and start automatically as a slot frees. This is the
// simplest, safest policy — it hands each active project the account's full
// rate-limit budget rather than splitting it, and a small project queued
// behind a large one still starts the moment the large one finishes its
// current STAGE (verify vs categorize are separate queue entries).

export type RunKind = "verify" | "categorize";

/**
 * Which QUEUED project starts next when a slot frees:
 *   - "fifo" (default): click order — the project waiting longest goes next.
 *   - "smallest-first": whichever queued project has the fewest products goes
 *     next, regardless of arrival order, so a quick project isn't stuck
 *     behind one that will run for hours.
 * Only affects the order queued entries are PICKED UP in — it never reorders
 * or interrupts runs already active.
 */
export type SchedulingPolicy = "fifo" | "smallest-first";

export type RunEntry = {
  /** Stable key for this run — same as projectId (one run per project at a time). */
  projectId: string;
  projectName: string;
  kind: RunKind;
  /** Product count, when known — only used to order the queue under
   *  "smallest-first"; irrelevant once a run is active. */
  size?: number;
  status: RunStatus | CategorizeStatus | null;
  startedAt: number;
};

type Listener = () => void;

const MAX_ACTIVE = 3;
// How long a finished/errored entry stays visible before it's dropped from
// the widget, so the user sees the outcome without having to dismiss it.
const SETTLE_MS = 10_000;

// Exported (not just the singleton below) so tests can instantiate an
// isolated store instead of sharing app-wide mutable state between cases.
export class RunQueueStore {
  private policy: SchedulingPolicy = "fifo";
  private queue: RunEntry[] = [];
  // Display map: everything shown in the widget, including a just-finished
  // entry kept visible for SETTLE_MS after its run actually ended.
  private active = new Map<string, RunEntry>();
  // The projects with a run TRULY in flight right now — this, not `active`'s
  // size, is what gates MAX_ACTIVE. Keeping a finished entry on screen for a
  // few seconds must not also keep occupying its concurrency slot.
  private runningIds = new Set<string>();
  private stopFlags = new Map<string, boolean>();
  private listeners = new Set<Listener>();
  // useSyncExternalStore requires getSnapshot to return a STABLE reference
  // when nothing has changed — recomputing fresh arrays on every call would
  // make every render look like a change and (in some React versions) loop
  // forever. Cache the snapshot and only rebuild it when emit() fires.
  private cachedSnapshot: { active: RunEntry[]; queue: RunEntry[]; policy: SchedulingPolicy } =
    { active: [], queue: [], policy: this.policy };

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  private emit(): void {
    // The displayed queue order matches what pump() will actually pick next,
    // under the current policy — so switching policy visibly reorders the
    // waiting list immediately, not just the next pick.
    this.cachedSnapshot = { active: [...this.active.values()], queue: this.orderedQueue(), policy: this.policy };
    for (const fn of this.listeners) fn();
  }

  getSnapshot = (): { active: RunEntry[]; queue: RunEntry[]; policy: SchedulingPolicy } => this.cachedSnapshot;

  getPolicy(): SchedulingPolicy {
    return this.policy;
  }

  setPolicy(policy: SchedulingPolicy): void {
    if (policy === this.policy) return;
    this.policy = policy;
    this.emit();
  }

  /** The queue in PICK order under the current policy — smallest-first sorts
   *  by known size (unknown-size entries last, conservatively); fifo is
   *  arrival order. Does not mutate the underlying queue. */
  private orderedQueue(): RunEntry[] {
    if (this.policy === "fifo") return [...this.queue];
    return [...this.queue].sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity));
  }

  isBusy(projectId: string): boolean {
    return this.runningIds.has(projectId) || this.queue.some((q) => q.projectId === projectId);
  }

  /** Add a project's next run to the queue. No-op if it's already running or
   *  queued. `size` (product count), when known, only matters for ordering
   *  under the "smallest-first" policy. */
  enqueue(projectId: string, projectName: string, kind: RunKind, size?: number): void {
    if (this.isBusy(projectId)) return;
    this.queue.push({ projectId, projectName, kind, size, status: null, startedAt: 0 });
    this.emit();
    this.pump();
  }

  /** Stop a queued or running entry. A running fetch already in flight finishes
   *  its current request, but the loop will not start another. */
  cancel(projectId: string): void {
    this.stopFlags.set(projectId, true);
    const wasQueued = this.queue.some((q) => q.projectId === projectId);
    if (wasQueued) this.queue = this.queue.filter((q) => q.projectId !== projectId);
    this.emit();
  }

  /** Remove a settled (done/error/paused) entry from view immediately. */
  dismiss(projectId: string): void {
    if (this.active.has(projectId)) {
      this.active.delete(projectId);
      this.emit();
    }
  }

  private setStatus(projectId: string, status: RunStatus | CategorizeStatus): void {
    const entry = this.active.get(projectId);
    if (!entry) return;
    this.active.set(projectId, { ...entry, status });
    this.emit();
  }

  /** The queue entry `pump()` should start next, under the current policy. */
  private pickNext(): RunEntry {
    if (this.policy === "fifo") return this.queue[0];
    let best = this.queue[0];
    for (const entry of this.queue) {
      if ((entry.size ?? Infinity) < (best.size ?? Infinity)) best = entry;
    }
    return best;
  }

  /** Start queued entries, in policy order, until MAX_ACTIVE truly-in-flight
   *  runs are reached. */
  private pump(): void {
    while (this.runningIds.size < MAX_ACTIVE && this.queue.length > 0) {
      const next = this.pickNext();
      this.queue = this.queue.filter((q) => q !== next);
      this.stopFlags.set(next.projectId, false);
      this.runningIds.add(next.projectId);
      const entry: RunEntry = { ...next, startedAt: Date.now() };
      this.active.set(next.projectId, entry);
      this.emit();
      void this.runOne(entry);
    }
  }

  private async runOne(entry: RunEntry): Promise<void> {
    const shouldStop = () => this.stopFlags.get(entry.projectId) === true;
    const onStatus = (s: RunStatus | CategorizeStatus) => this.setStatus(entry.projectId, s);
    try {
      if (entry.kind === "verify") {
        await runVerifyHeadless(entry.projectId, onStatus, shouldStop);
      } else {
        await runCategorizeHeadless(entry.projectId, onStatus, shouldStop);
      }
    } catch (e) {
      this.setStatus(entry.projectId, { phase: "error", done: 0, total: 0, message: e instanceof Error ? e.message : "Run failed" } as RunStatus);
    } finally {
      // Free the concurrency slot for the next queued project RIGHT NOW —
      // only the on-screen card lingers, not the run itself.
      this.runningIds.delete(entry.projectId);
      const settledEntry = this.active.get(entry.projectId);
      setTimeout(() => {
        // Keep the finished card visible for a moment, UNLESS a newer run for
        // the same project has already started (don't clobber it — compare
        // object identity, since a fresh run replaces this exact entry).
        if (this.active.get(entry.projectId) === settledEntry) this.dismiss(entry.projectId);
      }, SETTLE_MS);
      this.pump();
    }
  }
}

export const runQueue = new RunQueueStore();

/**
 * Whether `projectId` currently has NO run active or queued and its status
 * (uploaded/verified) allows one — used by the projects list to decide
 * whether to show a Run button and what action it should take.
 */
export function nextActionFor(status: string, isSkipVerify: boolean): RunKind | null {
  // Skip-verify marketplaces (Temu, Best Buy, …) go straight to Categorize;
  // any "verified" they carry is a stale status left over from before that
  // marketplace was reclassified, not a real completed Verify step.
  if (isSkipVerify) return status === "uploaded" || status === "verified" ? "categorize" : null;
  if (status === "uploaded") return "verify";
  if (status === "verified") return "categorize";
  return null;
}
