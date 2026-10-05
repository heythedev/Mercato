import { afterEach, describe, expect, it } from "vitest";

// The deployment switch is read at call time, so the value Vercel actually
// holds decides this — and Vercel holds the OLD per-tool list from before the
// decision moved to each account. These pin what that value means now, so
// nobody has to reason it out from the parser again.
const PRODUCTION_VALUE =
  "run_categorization,submit_categorization,submit_export_values,run_verification,"
  + "reverify_product,run_export,set_product_category,set_export_default,rename_project,"
  + "clear_product_field";

const original = process.env.MCP_WRITE_ENABLED;
afterEach(() => {
  if (original === undefined) delete process.env.MCP_WRITE_ENABLED;
  else process.env.MCP_WRITE_ENABLED = original;
});

async function mcpWrite(value: string | undefined): Promise<boolean> {
  if (value === undefined) delete process.env.MCP_WRITE_ENABLED;
  else process.env.MCP_WRITE_ENABLED = value;
  const { flags } = await import("./flags");
  return flags.mcpWrite();
}

describe("the write kill switch", () => {
  it("reads the stale per-tool list as ON", async () => {
    // It is no longer parsed as a list — any value that is not explicitly off
    // means the deployment permits writes, and WHICH tools is each account's
    // choice. So the stale value is harmless, if misleading to read.
    expect(await mcpWrite(PRODUCTION_VALUE)).toBe(true);
  });

  it("is on when unset", async () => {
    expect(await mcpWrite(undefined)).toBe(true);
    expect(await mcpWrite("")).toBe(true);
  });

  it("is off only when said so explicitly", async () => {
    for (const off of ["false", "0", "off", "no", "FALSE", " Off "]) {
      expect(await mcpWrite(off), off).toBe(false);
    }
    for (const on of ["true", "1", "on", "yes", "all"]) {
      expect(await mcpWrite(on), on).toBe(true);
    }
  });
});
