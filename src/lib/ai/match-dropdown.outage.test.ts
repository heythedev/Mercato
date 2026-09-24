import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Don't queue work for a provider that is known to be down.
 *
 * Measured on a real Best Buy export with the Moonshot balance at $0.00: the
 * run still built and dispatched 1,422 per-cell questions. Every one was
 * refused by the outage guard inside the fetch wrapper in under 100ms and
 * written down as a failed call — 969 of 993 failures on the usage screen for
 * that period never reached the provider at all.
 *
 * The point of the skip is that it costs nothing in accuracy. The outage guard
 * was going to refuse each request anyway, so the cells come out empty either
 * way and land in the compliance report the same. Both halves of that claim are
 * asserted here: nothing is dispatched, AND nothing is answered.
 */

let outage: { reason: string; at: number } | null = null;

vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("@/lib/ai/moonshot", () => ({
  moonshot: (m: string) => m,
  moonshotConfigured: () => true,
  moonshotTemperature: () => 0.2,
  noThinkingHeaders: () => ({}),
  noThinkingTemperature: () => 0.6,
  MOONSHOT_TEXT_MODEL: "test-model",
  getAiOutage: () => outage,
  classifyAiError: () => ({ fatal: false, reason: "x" }),
  AiUnavailableError: class extends Error {},
}));

import { generateText } from "ai";
import { fillDropdownValues, fillFreeTextValues, matchDropdownValues } from "./match-dropdown";

const down = () => {
  outage = { reason: "Kimi (AI) balance is $0.00 — the account is out of credit.", at: Date.now() };
};

beforeEach(() => {
  outage = null;
  vi.clearAllMocks();
});
afterEach(() => {
  outage = null;
});

describe("the fill queue when the provider is down", () => {
  it("matchDropdownValues sends nothing and answers nothing", async () => {
    down();
    const queries = Array.from({ length: 200 }, (_, i) => ({
      column: "Color",
      value: `vendor colour ${i}`,
      options: ["Red", "Blue", "Green"],
    }));
    const out = await matchDropdownValues(queries);
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });

  it("fillDropdownValues sends nothing and answers nothing", async () => {
    down();
    const out = await fillDropdownValues([
      { key: "k1", column: "Assembly Required", context: "A flat-pack oak bookcase", options: ["Yes", "No"] },
      { key: "k2", column: "Style", context: "A mid-century walnut sideboard", options: ["Modern", "Rustic"] },
    ]);
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });

  it("fillFreeTextValues sends nothing and answers nothing", async () => {
    down();
    const out = await fillFreeTextValues([
      { key: "k1", column: "Short Description", context: "A mid-century walnut sideboard" },
    ]);
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
    expect(out.size).toBe(0);
  });

  it("asks as usual the moment the outage lifts — a top-up must not need a redeploy", async () => {
    // The skip is keyed on the live outage marker, not on a flag latched for
    // the run. getAiOutage() expires its own marker after a couple of minutes,
    // so the next export picks the provider back up on its own.
    vi.mocked(generateText).mockResolvedValue({
      text: JSON.stringify([{ index: 1, match: "Red" }]),
    } as never);
    await matchDropdownValues([{ column: "Color", value: "crimson", options: ["Red", "Blue"] }]);
    expect(vi.mocked(generateText)).toHaveBeenCalled();
  });
});
