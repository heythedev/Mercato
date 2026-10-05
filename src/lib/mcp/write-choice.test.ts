import { describe, expect, it } from "vitest";
import { ALL_WRITE_TOOLS, WRITE_TOOLS, resolveWriteChoice } from "./write-tools";

/**
 * What a stored choice means, which is where the last outage in this feature
 * came from.
 *
 * The per-account choice shipped with an empty default. Every existing row
 * therefore read as "chose nothing", and the deploy revoked MCP write access
 * for every account at once — including one that had made a successful
 * submit_export_values call four hours earlier. Nothing was broken; the
 * default was simply the whole decision, for people who had never been asked.
 *
 * So the two directions are pinned here: the default must mean everything, and
 * an explicit choice must never be widened by a tool that ships later.
 */

const NAMES = WRITE_TOOLS.map((t) => t.name);

describe("resolveWriteChoice", () => {
  it("expands the sentinel to every write tool", () => {
    expect(resolveWriteChoice([ALL_WRITE_TOOLS])).toEqual(NAMES);
  });

  it("covers a tool added after the choice was made", () => {
    expect(resolveWriteChoice([ALL_WRITE_TOOLS], [...NAMES, "a_later_tool"])).toContain("a_later_tool");
  });

  it("never widens an explicit choice", () => {
    const chose = [NAMES[0]];
    expect(resolveWriteChoice(chose, [...NAMES, "a_later_tool"])).toEqual([NAMES[0]]);
  });

  it("reads an empty list as switched off, not as unset", () => {
    expect(resolveWriteChoice([])).toEqual([]);
  });

  it("drops a name that matches no tool", () => {
    expect(resolveWriteChoice(["set_product_category", "tool_that_was_removed"])).toEqual([
      "set_product_category",
    ]);
  });

  it("keeps the sentinel distinct from a tool name", () => {
    expect(NAMES).not.toContain(ALL_WRITE_TOOLS);
  });
});
