import { describe, it, expect } from "vitest";
import { Semaphore } from "./shared-sweep-limiter";

describe("Semaphore", () => {
  it("lets up to `max` acquisitions through immediately", async () => {
    const sem = new Semaphore(2);
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    expect(r1).toBeInstanceOf(Function);
    expect(r2).toBeInstanceOf(Function);
  });

  it("blocks the (max+1)th acquire until a slot is released", async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();

    let acquired = false;
    const p = sem.acquire().then((release) => { acquired = true; return release; });

    // Give the microtask queue a turn — the second acquire must still be waiting.
    await Promise.resolve();
    await Promise.resolve();
    expect(acquired).toBe(false);

    release1();
    const release2 = await p;
    expect(acquired).toBe(true);
    release2();
  });

  it("serves waiters in FIFO order", async () => {
    const sem = new Semaphore(1);
    const release0 = await sem.acquire();
    const order: number[] = [];
    const p1 = sem.acquire().then((r) => { order.push(1); return r; });
    const p2 = sem.acquire().then((r) => { order.push(2); return r; });

    release0();
    const r1 = await p1;
    r1();
    await p2;
    expect(order).toEqual([1, 2]);
  });

  it("a released slot can be reacquired", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    const release2 = await sem.acquire();
    expect(release2).toBeInstanceOf(Function);
  });
});
