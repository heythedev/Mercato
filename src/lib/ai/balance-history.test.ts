import { describe, expect, it } from "vitest";
import { spentCents, spentByDay, shouldSnapshot } from "./balance-history";

const at = (iso: string, balanceCents: number) => ({ balanceCents, capturedAt: new Date(iso) });

describe("spend measured from the balance", () => {
  it("is the drop between readings, with no rate involved", () => {
    expect(spentCents([at("2026-09-17T06:00:00Z", 5000), at("2026-09-17T09:00:00Z", 4100)])).toBe(900);
  });

  it("does not net a top-up against the spend around it", () => {
    // $50 spent, $50 added, $50 spent again is $100 of spend — netting the
    // readings end to end would report zero and hide both.
    const s = [
      at("2026-09-10T06:00:00Z", 5000),
      at("2026-09-10T18:00:00Z", 0),
      at("2026-09-11T06:00:00Z", 5000),
      at("2026-09-11T18:00:00Z", 0),
    ];
    expect(spentCents(s)).toBe(10000);
  });

  it("counts nothing when the balance never moves", () => {
    expect(spentCents([at("2026-09-17T06:00:00Z", 4167), at("2026-09-17T07:00:00Z", 4167)])).toBe(0);
  });

  it("needs two readings before it can report anything", () => {
    expect(spentCents([])).toBe(0);
    expect(spentCents([at("2026-09-17T06:00:00Z", 5000)])).toBe(0);
  });

  it("sorts readings rather than trusting their order", () => {
    const s = [at("2026-09-17T09:00:00Z", 4100), at("2026-09-17T06:00:00Z", 5000)];
    expect(spentCents(s)).toBe(900);
  });

  it("handles an overdrawn account, where the balance goes negative", () => {
    expect(spentCents([at("2026-09-15T06:00:00Z", 20), at("2026-09-15T08:00:00Z", -17)])).toBe(37);
  });

  it("attributes spend per day in the reporting zone", () => {
    // 20:00 UTC on the 16th is already the 17th in Asia/Kolkata (+05:30).
    const byDay = spentByDay([
      at("2026-09-16T10:00:00Z", 5000),
      at("2026-09-16T20:00:00Z", 4500),
    ]);
    expect(byDay.get("2026-09-17")).toBe(500);
    expect(byDay.get("2026-09-16")).toBeUndefined();
  });
});

describe("snapshot throttling", () => {
  const now = new Date("2026-09-17T12:00:00Z");

  it("always stores the first reading", () => {
    expect(shouldSnapshot(null, now, 5000)).toBe(true);
  });

  it("stores any change immediately — the change is the measurement", () => {
    const last = { balanceCents: 5000, capturedAt: new Date("2026-09-17T11:59:00Z") };
    expect(shouldSnapshot(last, now, 4990)).toBe(true);
  });

  it("skips an unchanged reading taken moments after the last", () => {
    const last = { balanceCents: 5000, capturedAt: new Date("2026-09-17T11:59:00Z") };
    expect(shouldSnapshot(last, now, 5000)).toBe(false);
  });

  it("still records an unchanged balance occasionally, so quiet reads as quiet", () => {
    const last = { balanceCents: 5000, capturedAt: new Date("2026-09-17T11:50:00Z") };
    expect(shouldSnapshot(last, now, 5000)).toBe(true);
  });
});
