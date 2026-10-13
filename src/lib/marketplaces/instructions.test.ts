import { describe, expect, it } from "vitest";
import { instructionBlock, MAX_INSTRUCTION_CHARS } from "./instructions";
import { isCorrection } from "@/lib/export/corrections";
import { buildCategorizationPrompt } from "@/lib/ai/categorize";

/**
 * Two halves of the same idea: Mercato learns nothing and Claude remembers
 * nothing between conversations, so a correction given in a chat helps one
 * project and then is gone.
 *
 * One half lets a person write the rule down where every run reads it. The
 * other keeps what people actually corrected, so there is something to look
 * at later — you cannot learn from data you never kept.
 */

describe("a standing rule, rendered into a prompt", () => {
  it("says whose rule it is", () => {
    // Dropped in as loose text it reads as part of the product data the model
    // is being asked to classify, not as an instruction about it.
    const block = instructionBlock("Describe colour by the fabric, not the frame.");
    expect(block).toMatch(/administrator/i);
    expect(block).toContain("Describe colour by the fabric, not the frame.");
  });

  it("says the category list still wins", () => {
    // Without this, a house rule that happens to contradict the taxonomy
    // invites the model off the list — which is the one failure this whole
    // pipeline is built to prevent.
    expect(instructionBlock("Prefer the Seasonal department.")).toMatch(/category list above, which always wins/i);
  });

  it("renders nothing at all when no rule is set", () => {
    // Not an empty heading: a "House rules:" with nothing under it reads to a
    // model as a rule it failed to understand.
    expect(instructionBlock(null)).toBe("");
    expect(instructionBlock("")).toBe("");
  });
});

describe("the rule reaches the model", () => {
  const product = { id: "p1", name: "Cashmere Pine Garland", brand: "Vickerman", description: "Artificial garland." };
  const categories = ["Home & Garden > Holiday & Seasonal Décor > Garlands"];

  it("is in the prompt when set", () => {
    const { systemPrompt } = buildCategorizationPrompt(
      [product], "ebay", "kimi-k2.7-code-highspeed", categories, false, false,
      "Seasonal items belong under Holiday & Seasonal Décor, never under Home Décor.",
    );
    expect(systemPrompt).toContain("never under Home Décor");
  });

  it("comes AFTER the category list, so it adds rather than replaces", () => {
    const { systemPrompt } = buildCategorizationPrompt(
      [product], "ebay", "kimi-k2.7-code-highspeed", categories, false, false, "A house rule.",
    );
    expect(systemPrompt.indexOf("A house rule.")).toBeGreaterThan(
      systemPrompt.indexOf("Home & Garden > Holiday & Seasonal Décor > Garlands"),
    );
  });

  it("changes nothing when unset", () => {
    const withNone = buildCategorizationPrompt([product], "ebay", "m", categories).systemPrompt;
    const withNull = buildCategorizationPrompt([product], "ebay", "m", categories, false, false, null).systemPrompt;
    expect(withNull).toBe(withNone);
  });

  it("is capped, because a prompt has a product to describe too", () => {
    expect(MAX_INSTRUCTION_CHARS).toBeLessThanOrEqual(4000);
  });
});

describe("what counts as a correction", () => {
  it("counts a real disagreement", () => {
    expect(isCorrection("Foam", "Polyethylene")).toBe(true);
  });

  it("does not count filling a blank", () => {
    // Nothing was wrong; a gap was closed. Counting it would make every
    // unfilled column look like one the model keeps getting wrong.
    expect(isCorrection("", "Polyethylene")).toBe(false);
    expect(isCorrection("  ", "Green")).toBe(false);
  });

  it("does not count the placeholders that mean blank", () => {
    for (const empty of ["N/A", "n/a", "none", "NULL", "---"]) {
      expect(isCorrection(empty, "Polyethylene"), empty).toBe(false);
    }
  });

  it("does not count clearing a value", () => {
    // "No answer is better than this one" is worth knowing, but it is not an
    // example of the right answer and must never be offered as one later.
    expect(isCorrection("Foam", "")).toBe(false);
  });

  it("does not count casing or punctuation", () => {
    // That is the template's own spelling rule, not a judgement about the
    // product — and counting it would bury the real disagreements.
    expect(isCorrection("polyethylene", "Polyethylene")).toBe(false);
    expect(isCorrection("Royal Blue", "royal-blue")).toBe(false);
    expect(isCorrection("4 x 10yd", "4x10yd")).toBe(false);
  });

  it("counts a change that is more than spacing", () => {
    expect(isCorrection("Royal Blue", "Navy Blue")).toBe(true);
  });
});
