import { describe, expect, it, afterEach } from "vitest";
import { flags, flagStates } from "./flags";

/**
 * Every recent addition has to be removable without a rollback.
 *
 * The rule the defaults follow: anything that only READS is on, anything that
 * WRITES is off until somebody decides otherwise. A feature nobody has asked
 * for should not be able to change data on the day it ships.
 *
 * MCP writes keep that rule without an off flag: each account starts with no
 * write tools chosen (User.mcpWriteTools), and MCP_WRITE_ENABLED is only the
 * kill switch over everybody's choices.
 */

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("feature flags", () => {
  it("defaults: reads on, and the write kill switch leaves it to each person", () => {
    delete process.env.MCP_ENABLED;
    delete process.env.MCP_WRITE_ENABLED;
    delete process.env.AI_SPEND_GUARD;
    expect(flags.mcp()).toBe(true);
    expect(flags.spendGuard()).toBe(true);
    // On does not mean writes are on: it means each person's own choice
    // counts, and every account starts with nothing chosen.
    expect(flags.mcpWrite()).toBe(true);
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

  it("write kill switch: off shuts it, anything else leaves it to each person", () => {
    for (const v of ["false", "0", "off", "no"]) {
      process.env.MCP_WRITE_ENABLED = v;
      expect(flags.mcpWrite(), v).toBe(false);
    }
    // The old per-tool list is still a deliberate "on": the decision of which
    // tools moved to each account, and a deployment configured the old way
    // must not lose MCP writes outright.
    for (const v of ["all", "true", "submit_categorization,rename_project"]) {
      process.env.MCP_WRITE_ENABLED = v;
      expect(flags.mcpWrite(), v).toBe(true);
    }
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
