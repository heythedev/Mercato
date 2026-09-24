import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The template's own instruction has to reach the model on every fill path.
 *
 * A marketplace template states, per field, what the cell wants ("Description")
 * and what a good answer looks like ("Value example"). The free-text fill has
 * always sent those. The dropdown fill did not — it sent the column header, the
 * product, and the option list, and nothing else. So any mandatory column that
 * happened to have a dropdown was answered from its header alone.
 *
 * That is the client's first feedback bullet, word for word: "The system should
 * follow the instructions mentioned in each mandatory cell." An option list
 * constrains what may be answered; it does not say which reading of the column
 * is meant, and for Best Buy the two often differ.
 */

vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("@/lib/ai/moonshot", () => ({
  moonshot: (m: string) => m,
  moonshotConfigured: () => true,
  moonshotTemperature: () => 0,
  noThinkingHeaders: () => ({}),
  noThinkingTemperature: () => 0,
  MOONSHOT_TEXT_MODEL: "test-model",
  getAiOutage: () => null,
  classifyAiError: () => ({ fatal: false, reason: "x" }),
  AiUnavailableError: class extends Error {},
}));

import { generateText } from "ai";
import { fillDropdownValues } from "./match-dropdown";

const promptSent = () =>
  String((vi.mocked(generateText).mock.calls[0]?.[0] as { prompt?: string } | undefined)?.prompt ?? "");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateText).mockResolvedValue({ text: "1: Yes" } as never);
});

describe("the template's instruction on the dropdown fill path", () => {
  it("puts the field description and value example in the prompt", async () => {
    await fillDropdownValues([
      {
        key: "p1|AB",
        column: "Assembly Required",
        description: "Whether the customer must assemble the item after delivery.",
        example: "Yes",
        context: "Flat-pack oak bookcase, 5 shelves",
        options: ["Yes", "No"],
      },
    ]);

    const prompt = promptSent();
    expect(prompt).toContain("Whether the customer must assemble the item after delivery.");
    expect(prompt).toContain("example value: Yes");
    // And the model is told the sheet outranks its own reading of the header.
    expect(prompt).toMatch(/follow it over your own reading of the column name/i);
  });

  it("omits the instruction lines cleanly when the template gives none", async () => {
    // Mathis templates leave Description blank on plenty of fields. A stray
    // "what this column wants:" with nothing after it is worse than silence.
    await fillDropdownValues([
      { key: "p1|AB", column: "Style", context: "Mid-century walnut sideboard", options: ["Modern", "Rustic"] },
    ]);

    const prompt = promptSent();
    expect(prompt).not.toContain("what this column wants");
    expect(prompt).not.toContain("example value");
    expect(prompt).toContain('column: "Style"');
    expect(prompt).toContain("Mid-century walnut sideboard");
  });

  it("does not collapse two columns that differ only by their instruction", async () => {
    // The fill deduplicates identical asks and fans one answer back out to
    // every key. Before the instruction was part of that key, these two became
    // one question and both cells took the same answer.
    await fillDropdownValues([
      {
        key: "p1|A",
        column: "Color",
        description: "The dominant colour of the item itself.",
        context: "Framed print of a red barn in a green field",
        options: ["Red", "Green", "White"],
      },
      {
        key: "p1|B",
        column: "Color",
        description: "The dominant colour of the frame or mount.",
        context: "Framed print of a red barn in a green field",
        options: ["Red", "Green", "White"],
      },
    ]);

    const prompt = promptSent();
    expect(prompt).toContain("The dominant colour of the item itself.");
    expect(prompt).toContain("The dominant colour of the frame or mount.");
    // Two distinct items, not one deduplicated ask.
    expect(prompt).toMatch(/^2\./m);
  });
});
