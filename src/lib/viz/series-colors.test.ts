import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SERIES_HEX, SERIES_HEX_DARK } from "./series-colors";

/**
 * The PDF report cannot read CSS, so it carries its own copy of the series
 * colours. This is the guard that stops the copy from drifting: it reads the
 * real declarations out of globals.css and compares.
 *
 * If this fails, the palette changed in one place and not the other. Fix
 * series-colors.ts to match globals.css, never the other way round.
 */

const css = fs.readFileSync(
  path.join(process.cwd(), "src", "app", "globals.css"),
  "utf8",
);

/** Declarations of one custom property, in source order: light block, then dark. */
function declared(name: string): string[] {
  return [...css.matchAll(new RegExp(`--series-${name}:\\s*(#[0-9a-fA-F]{6})`, "g"))].map((m) =>
    m[1].toLowerCase(),
  );
}

describe("series colours match globals.css", () => {
  for (const service of ["kimi", "keepa", "synccentric"] as const) {
    it(`${service} — light and dark steps both agree`, () => {
      const found = declared(service);
      // One in :root, one in the dark block. A third would mean an unnoticed
      // override that this guard should be told about.
      expect(found).toHaveLength(2);
      expect(found[0]).toBe(SERIES_HEX[service].toLowerCase());
      expect(found[1]).toBe(SERIES_HEX_DARK[service].toLowerCase());
    });
  }

  it("the two surfaces use different steps — a flipped palette is not a dark palette", () => {
    for (const s of Object.keys(SERIES_HEX)) {
      expect(SERIES_HEX[s]).not.toBe(SERIES_HEX_DARK[s]);
    }
  });
});
