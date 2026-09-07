"use client";

// "Fair share" for the multi-project Run Queue's image sweep: when several
// projects run at once, each has its OWN headless-verify sweep loop, and
// without coordination each independently fires its own chunk requests —
// with 3 active projects that could mean 3 simultaneous /verify/images
// requests, each doing up to CHUNK (12) concurrent vision calls server-side,
// i.e. up to 36 at once against one shared Kimi account. A plain counting
// semaphore, shared by every sweep loop in this browser tab, bounds how many
// SWEEP CHUNK REQUESTS are in flight across the WHOLE queue at once — the
// waiting requests queue in FIFO order, so throughput on the shared resource
// gets divided fairly across whichever projects are actively sweeping,
// automatically, with no per-policy bookkeeping needed elsewhere.

// Exported (not just the singleton below) so tests can instantiate an
// isolated semaphore instead of sharing app-wide state between cases.
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(max: number) {
    this.available = max;
  }

  /** Resolves once a slot is free; returns the function that releases it. */
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available--;
    return () => this.release();
  }

  private release(): void {
    this.available++;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// 2 concurrent chunk requests × CHUNK (12) images each = 24 simultaneous
// vision calls system-wide at most — comfortably inside the account's
// 200 requests/minute even alongside categorize traffic from other queued
// projects, regardless of how many projects are actively sweeping.
const MAX_CONCURRENT_SWEEP_REQUESTS = 2;

export const sweepLimiter = new Semaphore(MAX_CONCURRENT_SWEEP_REQUESTS);
