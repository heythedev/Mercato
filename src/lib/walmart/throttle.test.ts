import { describe, it, expect } from "vitest";
import { AdaptiveLimiter, RateLimitError, runPool } from "./throttle";

describe("AdaptiveLimiter", () => {
  it("never exceeds its concurrency limit", async () => {
    const limiter = new AdaptiveLimiter({ start: 5, min: 2, max: 5 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 100 }, () =>
        limiter.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(5);
    expect(active).toBe(0);
  });

  it("grows on sustained success", async () => {
    const limiter = new AdaptiveLimiter({ start: 4, min: 2, max: 32, growthThreshold: 5 });
    for (let i = 0; i < 100; i++) await limiter.run(async () => "ok");
    expect(limiter.width).toBeGreaterThan(4);
  });

  it("backs off on rate limiting", async () => {
    const limiter = new AdaptiveLimiter({ start: 16, min: 2, max: 32 });
    const before = limiter.width;
    await limiter.run(async () => { throw new RateLimitError(429); }).catch(() => {});
    expect(limiter.width).toBeLessThan(before);
  });

  it("does not compound multiple backoffs within the cooldown", async () => {
    const limiter = new AdaptiveLimiter({ start: 32, min: 2, max: 64 });
    for (let i = 0; i < 5; i++) {
      await limiter.run(async () => { throw new RateLimitError(429); }).catch(() => {});
    }
    // One halving (32 -> 16), not five (32 -> 1).
    expect(limiter.width).toBe(16);
  });

  it("does not treat ordinary errors as rate limiting", async () => {
    const limiter = new AdaptiveLimiter({ start: 16, min: 2, max: 32 });
    await limiter.run(async () => { throw new Error("boom"); }).catch(() => {});
    expect(limiter.width).toBe(16);
    expect(limiter.stats.errors).toBe(1);
  });

  it("releases slots when the task throws (no deadlock)", async () => {
    const limiter = new AdaptiveLimiter({ start: 2, min: 2, max: 2 });
    const rejects = Array.from({ length: 10 }, () =>
      limiter.run(async () => { throw new Error("x"); }).catch(() => "caught"),
    );
    // If a throw leaked a slot, the pool would stall and this would time out.
    const out = await Promise.all(rejects);
    expect(out).toHaveLength(10);
    // Pool is usable afterwards.
    await expect(limiter.run(async () => "fine")).resolves.toBe("fine");
  });
});

describe("re-entrancy", () => {
  // A pooled worker that internally calls another throttled helper used to wait
  // for a second slot while still holding its first — every slot ends up held by
  // a task waiting on a slot that can never free. This only manifests at full
  // load, which is exactly the 10k-product case.
  it("does not deadlock when a pooled worker acquires a slot again", async () => {
    const limiter = new AdaptiveLimiter({ start: 4, min: 4, max: 4 });
    const work = runPool([1, 2, 3, 4, 5, 6, 7, 8], limiter, async (n) =>
      limiter.run(async () => n),
    );
    const timeout = new Promise<string>((r) => setTimeout(() => r("TIMED_OUT"), 1000));
    const outcome = await Promise.race([work.then(() => "COMPLETED"), timeout]);
    expect(outcome).toBe("COMPLETED");
  });

  it("still honours the concurrency cap when nesting", async () => {
    const limiter = new AdaptiveLimiter({ start: 3, min: 3, max: 3 });
    let active = 0;
    let peak = 0;
    await runPool(Array.from({ length: 30 }, (_, i) => i), limiter, async (n) => {
      active++;
      peak = Math.max(peak, active);
      // Nested call must not open an additional concurrent request slot.
      const out = await limiter.run(async () => {
        await new Promise((r) => setTimeout(r, 3));
        return n;
      });
      active--;
      return out;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(active).toBe(0);
  });

  it("records nested outcomes so backoff still applies", async () => {
    const limiter = new AdaptiveLimiter({ start: 16, min: 2, max: 32 });
    const before = limiter.width;
    await limiter
      .run(async () => limiter.run(async () => { throw new RateLimitError(429); }))
      .catch(() => {});
    expect(limiter.width).toBeLessThan(before);
  });
});

describe("runPool", () => {
  it("preserves input order regardless of completion order", async () => {
    const limiter = new AdaptiveLimiter({ start: 8, min: 2, max: 8 });
    const items = [50, 10, 30, 5, 20];
    const out = await runPool(items, limiter, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(out.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual(items);
  });

  it("isolates failures to the individual item", async () => {
    const limiter = new AdaptiveLimiter({ start: 4, min: 2, max: 4 });
    const out = await runPool([1, 2, 3], limiter, async (n) => {
      if (n === 2) throw new Error("bad");
      return n;
    });
    expect(out[0].status).toBe("fulfilled");
    expect(out[1].status).toBe("rejected");
    expect(out[2].status).toBe("fulfilled");
  });

  it("does not barrier: a slow item never blocks later fast ones", async () => {
    const limiter = new AdaptiveLimiter({ start: 4, min: 4, max: 4 });
    const completionOrder: number[] = [];
    // One very slow item first, then fast ones. With chunk barriers the fast
    // items would wait; with a pool they finish first.
    await runPool([200, 5, 5, 5], limiter, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      completionOrder.push(i);
    });
    expect(completionOrder[completionOrder.length - 1]).toBe(0);
  });
});
