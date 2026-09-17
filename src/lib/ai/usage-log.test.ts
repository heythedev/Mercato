import { describe, it, expect } from "vitest";
import { recordUsageRow, pendingUsageRows, flushUsage } from "./usage-log";

// Recording is disabled under test (no database), so these assert the guard
// itself: a unit test run must never queue rows or attempt a write.
describe("usage log", () => {
  it("records nothing when disabled, so tests never touch the database", async () => {
    recordUsageRow({ service: "kimi", model: "kimi-k2.6", feature: "categorize", inputTokens: 10, outputTokens: 2, ok: true });
    recordUsageRow({ service: "keepa", feature: "product", units: 2, ok: true });
    expect(pendingUsageRows()).toBe(0);
    await expect(flushUsage()).resolves.toBeUndefined();
  });
});
