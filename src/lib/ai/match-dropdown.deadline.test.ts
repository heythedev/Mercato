import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("@/lib/ai/moonshot", () => ({
  moonshot: (m: string) => m,
  moonshotConfigured: () => true,
  moonshotTemperature: () => 0.2,
  MOONSHOT_TEXT_MODEL: "test-model",
  getAiOutage: () => null,
  classifyAiError: () => ({ fatal: false, reason: "x" }),
  AiUnavailableError: class extends Error {},
}));

import { generateText } from "ai";
import { matchDropdownValues, setDropdownDeadline } from "./match-dropdown";

afterEach(() => {
  setDropdownDeadline(null);
  vi.clearAllMocks();
});

// The export route is capped at maxDuration=300s but this fill was unbounded —
// one model round-trip per category per template. Eight consecutive Mathis
// exports of 24-40 products died at "Building spreadsheet files…" because of it.
describe("dropdown fill time budget", () => {
  it("dispatches no batches once the deadline has already passed", async () => {
    setDropdownDeadline(Date.now() - 1);
    const queries = Array.from({ length: 120 }, (_, i) => ({
      column: "Color", value: `v${i}`, options: ["Red", "Blue"],
    }));
    const out = await matchDropdownValues(queries);
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    expect(out.size).toBe(0); // unmatched values are simply left as they were
  });

  it("runs normally when no deadline is set", async () => {
    setDropdownDeadline(null);
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify([{ index: 1, match: "Red" }]),
    } as never);
    const out = await matchDropdownValues([
      { column: "Color", value: "crimson", options: ["Red", "Blue"] },
    ]);
    expect(vi.mocked(generateText)).toHaveBeenCalled();
    expect(out.size).toBeGreaterThanOrEqual(0);
  });

  it("a future deadline does not block work", async () => {
    setDropdownDeadline(Date.now() + 60_000);
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify([{ index: 1, match: "Blue" }]),
    } as never);
    await matchDropdownValues([
      { column: "Color", value: "navy", options: ["Red", "Blue"] },
    ]);
    expect(vi.mocked(generateText)).toHaveBeenCalled();
  });
});
