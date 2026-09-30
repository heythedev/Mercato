import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * A run that cannot finish should not begin.
 *
 * checkAiAvailable() already refuses at zero, which is correct and too late:
 * on 24 September a Best Buy export started with credit, ran out part-way,
 * and shipped an output sheet full of blank cells that a client then
 * complained about. Nobody knew the account was empty until they read it.
 */

let balance: number | null = 50;
let snapshots: { balanceCents: number; capturedAt: Date }[] = [];

vi.mock("@/lib/ai/moonshot", () => ({
  getLastMoonshotBalance: () => (balance == null ? null : { availableBalance: balance, timestamp: Date.now() }),
}));
vi.mock("@/lib/db", () => ({
  prisma: { balanceSnapshot: { findMany: async () => snapshots } },
}));

import { checkSpendBudget, estimateRunCostUsd } from "./spend-guard";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

beforeEach(() => {
  balance = 50;
  snapshots = [];
});

describe("spend guard", () => {
  it("lets a healthy balance through silently", async () => {
    const r = await checkSpendBudget();
    expect(r.ok).toBe(true);
    expect(r.warning).toBeNull();
  });

  it("holds a run when the balance is under the floor", async () => {
    balance = 2;
    const r = await checkSpendBudget();
    expect(r.ok).toBe(false);
    expect(r.warning).toContain("$2.00");
  });

  it("holds a run the balance cannot cover, even above the floor", async () => {
    // The case that actually bit: $12 in the account, a $40 export started
    // anyway, and it stopped two thirds through.
    balance = 12;
    const r = await checkSpendBudget(40);
    expect(r.ok).toBe(false);
    expect(r.warning).toContain("estimated at $40.00");
  });

  it("warns but proceeds when low", async () => {
    balance = 15;
    const r = await checkSpendBudget();
    expect(r.ok).toBe(true);
    expect(r.warning).toContain("Worth topping up");
  });

  it("does not block when the balance is unknown", async () => {
    // A failed probe is not evidence of an empty account, and refusing every
    // run because a health check timed out would be its own outage.
    balance = null;
    const r = await checkSpendBudget(100);
    expect(r.ok).toBe(true);
    expect(r.warning).toBeNull();
  });

  it("measures yesterday's spend from falls in the balance", async () => {
    snapshots = [
      { balanceCents: 5000, capturedAt: hoursAgo(20) },
      { balanceCents: 4200, capturedAt: hoursAgo(12) },
      { balanceCents: 3600, capturedAt: hoursAgo(2) },
    ];
    const r = await checkSpendBudget();
    expect(r.spentLast24hUsd).toBeCloseTo(14, 5);
  });

  it("ignores a top-up instead of netting it off", async () => {
    // $8 spent, then $50 added, then $2 spent. Netting would report a
    // CREDIT of $40 and call it a quiet day.
    snapshots = [
      { balanceCents: 1000, capturedAt: hoursAgo(20) },
      { balanceCents: 200, capturedAt: hoursAgo(14) },
      { balanceCents: 5200, capturedAt: hoursAgo(8) },
      { balanceCents: 5000, capturedAt: hoursAgo(1) },
    ];
    const r = await checkSpendBudget();
    expect(r.spentLast24hUsd).toBeCloseTo(10, 5);
  });

  it("reports nothing rather than guessing from one reading", async () => {
    snapshots = [{ balanceCents: 5000, capturedAt: hoursAgo(3) }];
    expect((await checkSpendBudget()).spentLast24hUsd).toBeNull();
  });
});

describe("run cost estimates", () => {
  it("puts image verification far above the others", async () => {
    const v = estimateRunCostUsd("verify", 2000);
    const c = estimateRunCostUsd("categorize", 2000);
    const e = estimateRunCostUsd("export", 2000);
    // Measured on live usage: verification is 92% of all tokens spent.
    expect(v).toBeGreaterThan(c * 3);
    expect(v).toBeGreaterThan(e * 3);
  });

  it("scales with the number of products", async () => {
    expect(estimateRunCostUsd("verify", 4000)).toBeCloseTo(estimateRunCostUsd("verify", 2000) * 2, 6);
  });

  it("puts a 2,000-product verification in a believable range", async () => {
    // The real 30-day bill was $90.21 across ~8,700 verifications, so ~2,000
    // should land in single-digit dollars rather than cents or hundreds.
    const v = estimateRunCostUsd("verify", 2000);
    expect(v).toBeGreaterThan(1);
    expect(v).toBeLessThan(30);
  });
});
