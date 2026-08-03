/**
 * Adaptive concurrency limiter for the Walmart APIs.
 *
 * Walmart does not publish a firm request/second ceiling, and the real limit
 * varies by credential tier, so a fixed concurrency is either too slow (safe
 * guess) or gets the run 429'd (optimistic guess). This finds the ceiling at
 * runtime instead: additive increase on sustained success, multiplicative
 * decrease the moment the API pushes back.
 *
 * The pool is shared per-limiter, so all products in a verify run draw from one
 * budget rather than each batch re-discovering the limit from scratch.
 */

import { AsyncLocalStorage } from "async_hooks";

/**
 * Tracks whether the current async context already holds a limiter slot.
 * A plain boolean field cannot express this: many tasks are in flight at once
 * and each needs its own answer, which is precisely what async-context storage
 * provides.
 */
const holdingSlot = new AsyncLocalStorage<boolean>();

export type ThrottleStats = {
  completed: number;
  rateLimited: number;
  errors: number;
  currentLimit: number;
  peakLimit: number;
  /** Total wall time spent inside calls, summed across concurrent tasks. */
  totalLatencyMs: number;
  /** Slowest single call — a large gap vs the mean points at retry backoff. */
  maxLatencyMs: number;
};

type Waiter = () => void;

export class AdaptiveLimiter {
  private limit: number;
  private readonly min: number;
  private readonly max: number;
  private active = 0;
  private queue: Waiter[] = [];

  /** Consecutive successes since the last backoff — drives additive increase. */
  private streak = 0;
  /** Successes needed before widening by one slot. */
  private readonly growthThreshold: number;
  /** Until this timestamp, refuse to grow (lets a backoff actually settle). */
  private coolDownUntil = 0;

  readonly stats: ThrottleStats;

  constructor(opts?: { start?: number; min?: number; max?: number; growthThreshold?: number }) {
    this.min = opts?.min ?? 2;
    this.max = opts?.max ?? 64;
    this.limit = opts?.start ?? 12;
    this.growthThreshold = opts?.growthThreshold ?? 20;
    this.stats = {
      completed: 0,
      rateLimited: 0,
      errors: 0,
      currentLimit: this.limit,
      peakLimit: this.limit,
      totalLatencyMs: 0,
      maxLatencyMs: 0,
    };
  }

  /** Signal that a call came back clean. May widen the pool. */
  private onSuccess(): void {
    this.stats.completed++;
    if (Date.now() < this.coolDownUntil) return;
    this.streak++;
    if (this.streak >= this.growthThreshold && this.limit < this.max) {
      this.limit++;
      this.streak = 0;
      this.stats.currentLimit = this.limit;
      this.stats.peakLimit = Math.max(this.stats.peakLimit, this.limit);
      this.drain();
    }
  }

  /**
   * Signal that the API pushed back (429 / 5xx). Halves the pool and refuses to
   * grow for a cooldown window, so a burst of 429s from one overshoot doesn't
   * compound into repeated halvings down to `min`.
   */
  private onPushback(): void {
    this.stats.rateLimited++;
    if (Date.now() < this.coolDownUntil) return; // already backing off
    this.limit = Math.max(this.min, Math.floor(this.limit / 2));
    this.streak = 0;
    this.coolDownUntil = Date.now() + 3000;
    this.stats.currentLimit = this.limit;
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length) {
      const next = this.queue.shift()!;
      this.active++;
      next();
    }
  }

  private release(): void {
    this.active--;
    this.drain();
  }

  /**
   * Run `fn` when a slot is free. `fn` should return the outcome so the limiter
   * can adapt; throwing is treated as a plain error, not as rate-limiting.
   *
   * Re-entrant by design: a task that already holds a slot (e.g. a worker in
   * `runPool` that internally calls another throttled helper) passes straight
   * through instead of queueing for a second slot. Without this, held slots wait
   * on queued slots that can never start — a deadlock that only appears once
   * every slot is occupied, i.e. exactly at full load.
   *
   * The outcome is still recorded, so nested calls continue to drive the
   * adaptive limit even though they don't consume an extra slot.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (holdingSlot.getStore()) return this.observe(fn);

    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await holdingSlot.run(true, () => this.observe(fn));
    } finally {
      this.release();
    }
  }

  /** Run `fn`, feeding its success/failure into the adaptive limit. No slot accounting. */
  private async observe<T>(fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      const out = await fn();
      this.onSuccess();
      return out;
    } catch (e) {
      if (e instanceof RateLimitError) this.onPushback();
      else this.stats.errors++;
      throw e;
    } finally {
      const dt = Date.now() - t0;
      this.stats.totalLatencyMs += dt;
      this.stats.maxLatencyMs = Math.max(this.stats.maxLatencyMs, dt);
    }
  }

  /** Mean call latency in ms, or 0 before any call completes. */
  get meanLatencyMs(): number {
    const n = this.stats.completed + this.stats.errors + this.stats.rateLimited;
    return n ? this.stats.totalLatencyMs / n : 0;
  }

  /** Current pool width — exposed for logging. */
  get width(): number {
    return this.limit;
  }
}

/** Thrown by fetch wrappers on 429/5xx so the limiter can distinguish pushback from bugs. */
export class RateLimitError extends Error {
  constructor(public readonly status: number) {
    super(`Walmart API rate limited (${status})`);
    this.name = "RateLimitError";
  }
}

/**
 * Fetch with retry on rate-limit responses. Honours `Retry-After` when present,
 * otherwise exponential backoff with jitter. Returns the response once it is
 * either a success or a non-retryable failure.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts?: { retries?: number },
): Promise<Response> {
  const retries = opts?.retries ?? 3;
  let lastStatus = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (e) {
      // Network-level failure — retry with backoff, it's usually transient.
      if (attempt === retries) throw e;
      await sleep(backoffMs(attempt));
      continue;
    }

    if (res.status !== 429 && res.status < 500) return res;
    lastStatus = res.status;
    if (attempt === retries) break;

    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : backoffMs(attempt);
    await sleep(waitMs);
  }

  // Out of retries and still being pushed back — surface it so the limiter narrows.
  throw new RateLimitError(lastStatus);
}

function backoffMs(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** attempt);
  return base + Math.random() * 250; // jitter to de-synchronize a burst
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run every item through `worker` with no batch barriers: a slot freed by a fast
 * item is immediately taken by the next queued one, so one slow product never
 * blocks the rest of its chunk. Results come back in input order.
 *
 * Rejections are captured per-item rather than failing the whole pool, matching
 * the Promise.allSettled semantics the callers already expect.
 */
export async function runPool<T, R>(
  items: T[],
  limiter: AdaptiveLimiter,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return Promise.all(
    items.map(async (item, i): Promise<PromiseSettledResult<R>> => {
      try {
        return { status: "fulfilled", value: await limiter.run(() => worker(item, i)) };
      } catch (reason) {
        return { status: "rejected", reason };
      }
    }),
  );
}
