import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Deferred controls so each test can decide exactly when a "run" finishes,
// without any real network or timer dependency.
type Deferred = { resolve: () => void; onStatus: ((s: unknown) => void) | null };
const pending = new Map<string, Deferred>();

function makeRunner() {
  return vi.fn((projectId: string, onStatus: (s: unknown) => void, _shouldStop: () => boolean) => {
    return new Promise<void>((resolve) => {
      pending.set(projectId, { resolve, onStatus });
    });
  });
}

const verifyRunner = makeRunner();
const categorizeRunner = makeRunner();

vi.mock("@/lib/client/headless-verify", () => ({
  runVerifyHeadless: (...args: [string, (s: unknown) => void, () => boolean]) => verifyRunner(...args),
}));
vi.mock("@/lib/client/headless-categorize", () => ({
  runCategorizeHeadless: (...args: [string, (s: unknown) => void, () => boolean]) => categorizeRunner(...args),
}));

import { RunQueueStore, nextActionFor } from "./run-queue-store";

describe("nextActionFor", () => {
  it("offers verify for an uploaded project, categorize for a verified one", () => {
    expect(nextActionFor("uploaded", false)).toBe("verify");
    expect(nextActionFor("verified", false)).toBe("categorize");
  });

  it("offers nothing once categorized, exporting, or done", () => {
    expect(nextActionFor("categorized", false)).toBeNull();
    expect(nextActionFor("exporting", false)).toBeNull();
    expect(nextActionFor("done", false)).toBeNull();
  });

  it("skip-verify marketplaces go straight to categorize from either uploaded or a stale verified", () => {
    expect(nextActionFor("uploaded", true)).toBe("categorize");
    expect(nextActionFor("verified", true)).toBe("categorize");
    expect(nextActionFor("categorized", true)).toBeNull();
  });
});

function finish(projectId: string) {
  const d = pending.get(projectId);
  if (!d) throw new Error(`no pending run for ${projectId}`);
  pending.delete(projectId);
  d.resolve();
}

describe("RunQueueStore", () => {
  let store: RunQueueStore;

  beforeEach(() => {
    vi.useFakeTimers();
    pending.clear();
    verifyRunner.mockClear();
    categorizeRunner.mockClear();
    store = new RunQueueStore();
  });
  afterEach(() => vi.useRealTimers());

  it("starts a run immediately when under the concurrency limit", () => {
    store.enqueue("p1", "Project 1", "verify");
    expect(verifyRunner).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().active.map((e) => e.projectId)).toEqual(["p1"]);
    expect(store.getSnapshot().queue).toEqual([]);
  });

  it("queues the 4th project once 3 are already running (default MAX_ACTIVE)", () => {
    store.enqueue("p1", "P1", "verify");
    store.enqueue("p2", "P2", "verify");
    store.enqueue("p3", "P3", "verify");
    store.enqueue("p4", "P4", "verify");
    expect(verifyRunner).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().active.map((e) => e.projectId).sort()).toEqual(["p1", "p2", "p3"]);
    expect(store.getSnapshot().queue.map((e) => e.projectId)).toEqual(["p4"]);
    expect(store.isBusy("p4")).toBe(true);
  });

  it("starts the queued project the moment a running slot frees, in FIFO order", async () => {
    store.enqueue("p1", "P1", "verify");
    store.enqueue("p2", "P2", "verify");
    store.enqueue("p3", "P3", "verify");
    store.enqueue("p4", "P4", "verify");
    store.enqueue("p5", "P5", "verify");
    expect(store.getSnapshot().queue.map((e) => e.projectId)).toEqual(["p4", "p5"]);

    finish("p2"); // middle slot finishes first
    await vi.waitFor(() => expect(verifyRunner).toHaveBeenCalledTimes(4));

    expect(store.getSnapshot().queue.map((e) => e.projectId)).toEqual(["p5"]);
    // p4 took the freed slot (FIFO), p1/p3 still running, p2 settling.
    const activeIds = store.getSnapshot().active.map((e) => e.projectId).sort();
    expect(activeIds).toEqual(["p1", "p2", "p3", "p4"]);
    expect(store.isBusy("p4")).toBe(true);
  });

  it("refuses a duplicate enqueue for a project already running or queued", () => {
    store.enqueue("p1", "P1", "verify");
    store.enqueue("p1", "P1", "verify");
    expect(verifyRunner).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().active).toHaveLength(1);
  });

  it("routes categorize entries to the categorize runner, verify to the verify runner", () => {
    store.enqueue("p1", "P1", "verify");
    store.enqueue("p2", "P2", "categorize");
    expect(verifyRunner).toHaveBeenCalledWith("p1", expect.any(Function), expect.any(Function));
    expect(categorizeRunner).toHaveBeenCalledWith("p2", expect.any(Function), expect.any(Function));
  });

  it("removes a queued (not yet started) entry on cancel, without touching running ones", () => {
    store.enqueue("p1", "P1", "verify");
    store.enqueue("p2", "P2", "verify");
    store.enqueue("p3", "P3", "verify");
    store.enqueue("p4", "P4", "verify"); // queued
    store.cancel("p4");
    expect(store.getSnapshot().queue).toEqual([]);
    expect(store.isBusy("p4")).toBe(false);
    expect(store.getSnapshot().active.map((e) => e.projectId).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("keeps a finished entry visible for a while, then drops it, freeing isBusy immediately", async () => {
    store.enqueue("p1", "P1", "verify");
    finish("p1");
    await vi.waitFor(() => expect(store.getSnapshot().active).toHaveLength(1));
    // The slot is free right away even though the card still shows...
    expect(store.isBusy("p1")).toBe(false);
    expect(store.getSnapshot().active[0].projectId).toBe("p1");
    // ...and the card itself clears after the settle window.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.getSnapshot().active).toEqual([]);
  });

  it("re-enqueuing a project right after it finishes starts a fresh run without waiting out the settle window", async () => {
    store.enqueue("p1", "P1", "verify");
    finish("p1");
    await vi.waitFor(() => expect(verifyRunner).toHaveBeenCalledTimes(1));
    store.enqueue("p1", "P1", "categorize");
    expect(categorizeRunner).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().active.find((e) => e.projectId === "p1")?.kind).toBe("categorize");
  });

  it("notifies subscribers on every state change and returns a stable snapshot reference otherwise", () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const snapshotBefore = store.getSnapshot();
    expect(store.getSnapshot()).toBe(snapshotBefore); // stable reference — required for useSyncExternalStore
    store.enqueue("p1", "P1", "verify");
    expect(listener).toHaveBeenCalled();
    expect(store.getSnapshot()).not.toBe(snapshotBefore);
    unsubscribe();
  });
});
