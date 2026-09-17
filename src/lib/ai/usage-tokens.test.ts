import { describe, expect, it } from "vitest";
import { usageTokens } from "./moonshot";

describe("token extraction from provider usage", () => {
  it("reads the nested v3 shape the SDK actually returns", () => {
    // This is the shape that was silently recording zeros: inputTokens is an
    // object, Number() of it is NaN, and `|| 0` made that look like a real zero.
    const usage = {
      inputTokens: { total: 1200, noCache: 1000, cacheRead: 200, cacheWrite: 0 },
      outputTokens: { total: 340, text: 300, reasoning: 40 },
    };
    expect(usageTokens(usage)).toEqual({ input: 1200, output: 340 });
  });

  it("still reads the flat numeric shape older versions returned", () => {
    expect(usageTokens({ inputTokens: 90, outputTokens: 12 })).toEqual({ input: 90, output: 12 });
  });

  it("falls back to the provider's own raw counts", () => {
    // Moonshot reports snake_case; kept as a last resort so a third shape change
    // cannot zero the figures again.
    expect(usageTokens({ raw: { prompt_tokens: 55, completion_tokens: 7 } })).toEqual({
      input: 55,
      output: 7,
    });
  });

  it("returns zeros for a missing or unusable usage object", () => {
    expect(usageTokens(undefined)).toEqual({ input: 0, output: 0 });
    expect(usageTokens({})).toEqual({ input: 0, output: 0 });
    expect(usageTokens({ inputTokens: { total: undefined } })).toEqual({ input: 0, output: 0 });
    expect(usageTokens({ inputTokens: "1200" })).toEqual({ input: 0, output: 0 });
  });

  it("ignores negative counts rather than recording them", () => {
    expect(usageTokens({ inputTokens: { total: -5 }, outputTokens: { total: 10 } })).toEqual({
      input: 0,
      output: 10,
    });
  });
});
