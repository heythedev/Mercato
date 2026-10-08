import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { RUNS_PER_DAY as RUNS_FROM_INVOKE } from "./invoke";
import {
  CATEGORIZE_BATCH,
  CATEGORIZE_BATCH_MAX,
  DOWNLOAD_TICKET_TTL_MS,
  EXPORT_GAPS_BATCH,
  EXPORT_GAPS_BATCH_MAX,
  MAX_INLINE_UPLOAD_BYTES,
  MAX_ROWS,
  MAX_WRITE,
  RUNS_PER_DAY,
} from "./limits";

/**
 * The Help page prints these numbers and the tools enforce them. If the two
 * ever come from different places, the page is wrong in the one document a
 * person reads precisely because they do not already know the answer — and
 * being wrong there is invisible, because the reader cannot catch it.
 *
 * So: one module, and a test that nothing has quietly grown a second copy.
 */

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the limits are defined once", () => {
  it("is the same RUNS_PER_DAY the quota check uses", () => {
    expect(RUNS_FROM_INVOKE).toBe(RUNS_PER_DAY);
  });

  it("has no second declaration in the tool modules", () => {
    const sources = [
      "src/lib/mcp/tools.ts",
      "src/lib/mcp/write-tools.ts",
      "src/lib/mcp/invoke.ts",
    ].map(read);

    for (const name of [
      "MAX_ROWS",
      "MAX_WRITE",
      "CATEGORIZE_BATCH",
      "CATEGORIZE_BATCH_MAX",
      "DOWNLOAD_TICKET_TTL_MS",
      "RUNS_PER_DAY",
    ]) {
      for (const src of sources) {
        // `const MAX_ROWS = 200` anywhere outside limits.ts means the Help
        // page and the tool have started disagreeing.
        expect(new RegExp(`const\\s+${name}\\s*=\\s*\\d`).test(src), name).toBe(false);
      }
    }
  });

  it("does not print a number the Help page would have to round badly", () => {
    // Both are rendered as whole units — 8MB, 15 minutes. A limit that is not
    // a whole number of those would be shown wrong rather than shown oddly.
    expect(MAX_INLINE_UPLOAD_BYTES % (1024 * 1024)).toBe(0);
    expect(DOWNLOAD_TICKET_TTL_MS % 60_000).toBe(0);
  });

  it("keeps each batch default under its own ceiling", () => {
    expect(CATEGORIZE_BATCH).toBeLessThanOrEqual(CATEGORIZE_BATCH_MAX);
    expect(EXPORT_GAPS_BATCH).toBeLessThanOrEqual(EXPORT_GAPS_BATCH_MAX);
    // A write cap below a read cap would mean rows that can be fetched in one
    // call and not sent back in one.
    expect(MAX_WRITE).toBeGreaterThanOrEqual(MAX_ROWS);
  });
});

describe("the Help page reads them rather than restating them", () => {
  it("imports every number it prints", () => {
    const page = read("src/app/(app)/help/page.tsx");
    for (const name of [
      "RUNS_PER_DAY",
      "MAX_ROWS",
      "MAX_WRITE",
      "CATEGORIZE_BATCH",
      "EXPORT_GAPS_BATCH",
      "MAX_INLINE_UPLOAD_BYTES",
      "DOWNLOAD_TICKET_TTL_MS",
    ]) {
      expect(page, name).toContain(name);
    }
    expect(page).toContain('from "@/lib/mcp/limits"');
  });

  it("hardcodes no limit in the page people read", () => {
    const client = read("src/components/help/help-client.tsx");
    // Every number on the page arrives as a prop. A literal "20 exports" or
    // "8MB" written into the copy is the drift this whole file exists to stop.
    expect(client).not.toMatch(/\b20 (exports|runs|per day)/i);
    expect(client).not.toMatch(/\b8\s?MB\b/i);
    expect(client).not.toMatch(/\b15 minutes\b/i);
    expect(client).not.toMatch(/\b500 values\b/i);
  });
});
