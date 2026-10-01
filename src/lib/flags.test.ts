import { describe, expect, it, afterEach } from "vitest";
import { flags, flagStates, mcpWriteTools, writeToolEnabled } from "./flags";

/**
 * Every recent addition has to be removable without a rollback.
 *
 * The rule the defaults follow: anything that only READS is on, anything that
 * WRITES is off until somebody decides otherwise. A feature nobody has asked
 * for should not be able to change data on the day it ships.
 */

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("feature flags", () => {
  it("defaults: reads on, writes off", () => {
    delete process.env.MCP_ENABLED;
    delete process.env.MCP_WRITE_ENABLED;
    delete process.env.AI_SPEND_GUARD;
    expect(flags.mcp()).toBe(true);
    expect(flags.spendGuard()).toBe(true);
    // The important one. Letting a language model change a live catalogue is
    // a decision a person makes deliberately, not one that arrives on deploy.
    expect(flags.mcpWrite()).toBe(false);
  });

  it("accepts the ways a person actually writes 'off'", () => {
    for (const v of ["false", "FALSE", "0", "off", "No", " false "]) {
      process.env.MCP_ENABLED = v;
      expect(flags.mcp(), `MCP_ENABLED=${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("treats anything else as on", () => {
    for (const v of ["true", "1", "yes", "on", "enabled"]) {
      process.env.MCP_WRITE_ENABLED = v;
      expect(flags.mcpWrite(), `MCP_WRITE_ENABLED=${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("an empty or blank value means 'not set', not 'off'", () => {
    // A platform that writes "" for an unset variable must not silently
    // disable a feature that defaults on.
    process.env.MCP_ENABLED = "";
    expect(flags.mcp()).toBe(true);
    process.env.MCP_ENABLED = "   ";
    expect(flags.mcp()).toBe(true);
  });

  it("is read at call time, so a change needs no deploy to notice", () => {
    process.env.AI_SPEND_GUARD = "false";
    expect(flags.spendGuard()).toBe(false);
    process.env.AI_SPEND_GUARD = "true";
    expect(flags.spendGuard()).toBe(true);
  });

  it("enables write tools one at a time", () => {
    // A single switch forced a choice nobody should make: turning on category
    // assignment also turned on clearing fields and setting a default that
    // governs every future export.
    process.env.MCP_WRITE_ENABLED = "submit_categorization,rename_project";
    expect(mcpWriteTools()).toEqual(["submit_categorization", "rename_project"]);
    expect(writeToolEnabled("submit_categorization")).toBe(true);
    expect(writeToolEnabled("rename_project")).toBe(true);
    expect(writeToolEnabled("clear_product_field")).toBe(false);
    expect(writeToolEnabled("set_export_default")).toBe(false);
    // Any write tool being on still counts as writes being on.
    expect(flags.mcpWrite()).toBe(true);
  });

  it("still takes a plain yes or no", () => {
    for (const v of ["true", "1", "on", "yes", "all"]) {
      process.env.MCP_WRITE_ENABLED = v;
      expect(mcpWriteTools(), v).toBe("all");
      expect(writeToolEnabled("anything"), v).toBe(true);
    }
    for (const v of ["false", "0", "off", "no", ""]) {
      process.env.MCP_WRITE_ENABLED = v;
      expect(mcpWriteTools(), JSON.stringify(v)).toBe("none");
      expect(writeToolEnabled("submit_categorization"), v).toBe(false);
    }
    delete process.env.MCP_WRITE_ENABLED;
    expect(mcpWriteTools()).toBe("none");
  });

  it("a misspelled tool name disables rather than silently enables", () => {
    // The quiet failure would be matching nothing while reporting success.
    process.env.MCP_WRITE_ENABLED = "submit_categorisation"; // British spelling
    expect(writeToolEnabled("submit_categorization")).toBe(false);
  });

  it("ignores spacing and case in the list", () => {
    process.env.MCP_WRITE_ENABLED = " Submit_Categorization , rename_project ";
    expect(writeToolEnabled("submit_categorization")).toBe(true);
    expect(writeToolEnabled("rename_project")).toBe(true);
  });

  it("reports every flag for diagnostics", () => {
    expect(Object.keys(flagStates()).sort()).toEqual([
      "cacheCleanup",
      "mcp",
      "mcpWrite",
      "spendGuard",
      "uiPreview",
    ]);
  });
});
