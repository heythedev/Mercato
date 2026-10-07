import { describe, expect, it } from "vitest";
import { parseVendorFile } from "./parse";

// A CSV field may contain a line break when it is quoted. The parser split the
// text on newlines first and parsed each line, so a record whose description
// is an HTML <li> list — which is how this vendor writes them — was cut in two:
// the first half came up short, the second half became a row of its own, and
// every value in it landed under the wrong header.
//
// What that produced in a finished export, on a real Vickerman file: a brand
// reading "7" and a colour reading "US". The export was writing faithfully
// what the parse had stored, so it surfaced at the very end, in a file QA had
// already spent an afternoon on.

const file = (text: string) => parseVendorFile(Buffer.from(text, "utf-8"), "vendor.csv");

describe("a CSV field containing a line break", () => {
  it("stays one record, with its columns in the right places", async () => {
    const { rows } = await file(
      "sku,name,brand,color\n"
        + 'A118286LED,"<li>9.5\' Cashmere Pine</li>\n<li>Color : Green</li>",Vickerman,Green\n'
        + "A118314LED,Plain title,Vickerman,Warm White\n",
    );

    expect(rows).toHaveLength(2);
    const [first, second] = rows as unknown as Record<string, string>[];

    // The brand is the brand — not a number from a continuation line.
    expect(first.brand ?? first.Brand).toBe("Vickerman");
    expect(second.brand ?? second.Brand).toBe("Vickerman");
    // And the colour is a colour, not a country.
    expect(first.color ?? first.Color).toBe("Green");
    expect(second.color ?? second.Color).toBe("Warm White");
  });

  it("keeps the line break inside the value", async () => {
    const { rows } = await file(
      "sku,name\n" + 'A1,"first line\nsecond line"\n',
    );
    expect(rows).toHaveLength(1);
    expect(String((rows[0] as unknown as Record<string, string>).name)).toContain("second line");
  });

  it("handles an escaped quote beside a line break", async () => {
    const { rows } = await file(
      "sku,name\n" + 'A1,"9.5"" tree\nwith a break",\n',
    );
    expect(rows).toHaveLength(1);
    const name = String((rows[0] as unknown as Record<string, string>).name);
    expect(name).toContain('9.5"');
    expect(name).toContain("with a break");
  });

  it("is unchanged for a file with no line break inside a field", async () => {
    const { rows } = await file(
      "sku,name,brand\nA1,One,Vickerman\nA2,Two,Vickerman\nA3,Three,Vickerman\n",
    );
    expect(rows).toHaveLength(3);
  });

  it("reads a CRLF file without inventing blank rows", async () => {
    const { rows } = await file("sku,name\r\nA1,One\r\nA2,Two\r\n");
    expect(rows).toHaveLength(2);
  });

  it("does not lose the last record when the file has no trailing newline", async () => {
    const { rows } = await file("sku,name\nA1,One\nA2,Two");
    expect(rows).toHaveLength(2);
  });
});
