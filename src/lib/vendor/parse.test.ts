import { describe, it, expect } from "vitest";
import { parseVendorFile } from "./parse";

function csv(rows: string[][]): Buffer {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return Buffer.from(rows.map((r) => r.map(esc).join(",")).join("\n"), "utf8");
}

describe("vendor SKU detection", () => {
  it("detects a SKU column of alphanumeric part numbers", async () => {
    // Regression: `toDisplayBarcode` strips non-digits, so "E1TL05001809"
    // normalised to "000105001809" and was mistaken for a 12-digit UPC. That
    // disqualified every SKU column in a 4,996-product sheet, which imported
    // with vendorSku = null on every row.
    const parsed = await parseVendorFile(
      csv([
        ["SKU", "UPC", "Title"],
        ["3DUA-E1TL05001809", "190204940575", "Floor Mat Set"],
        ["3DUA-E1TL05401809", "190204960399", "Cargo Net"],
        ["3DUA-E1TL06901809", "190204960665", "Dry Bag"],
      ]),
      "t.csv",
    );
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[0].sku).toBe("3DUA-E1TL05001809");
    expect(parsed.rows[0].upc).toBe("190204940575");
  });

  it("still refuses a SKU column that really holds barcodes", async () => {
    // The disqualifier exists for Amazon-sourced sheets that head a barcode
    // column "SKU"; it must keep working for genuine digit strings.
    const parsed = await parseVendorFile(
      csv([
        ["SKU", "Item No", "Title"],
        ["190204940575", "ABC-100", "Floor Mat Set"],
        ["190204960399", "ABC-101", "Cargo Net"],
        ["190204960665", "ABC-102", "Dry Bag"],
      ]),
      "t.csv",
    );
    // The barcode-valued "SKU" column is rejected; the real part-number column wins.
    expect(parsed.rows[0].sku).toBe("ABC-100");
  });

  it("prefers a column literally named SKU over other candidates", async () => {
    const parsed = await parseVendorFile(
      csv([
        ["Key Field", "SKU", "Vendor SKU", "Title"],
        ["K-1", "SKU-100", "V-100", "Widget A"],
        ["K-2", "SKU-101", "V-101", "Widget B"],
      ]),
      "t.csv",
    );
    expect(parsed.rows[0].sku).toBe("SKU-100");
  });

  it("picks the real Description column over a leftward Note column", async () => {
    // Regression: a single combined pattern matched first-to-last, so a "Note"
    // column (holding the title) at index 1 beat "Description" at index 3.
    // Every exported description was then a copy of the product name.
    const parsed = await parseVendorFile(
      csv([
        ["SKU", "Note", "Title", "Description"],
        ["A-1", "Widget A", "Widget A", "A durable steel widget for workshop use."],
        ["A-2", "Widget B", "Widget B", "A compact brass widget with a knurled grip."],
      ]),
      "t.csv",
    );
    expect(parsed.rows[0].description).toBe("A durable steel widget for workshop use.");
    expect(parsed.rows[0].description).not.toBe(parsed.rows[0].name);
  });

  it("strips HTML markup from descriptions", async () => {
    // Vendor sheets paste CMS copy verbatim, including malformed closers ("< p>").
    const parsed = await parseVendorFile(
      csv([
        ["SKU", "Description", "Title"],
        ["A-1", "<p>ROLL-TOP DRY BAG BACKPACK&nbsp;ARMY GREEN&amp;BLACK< p>", "Dry Bag"],
      ]),
      "t.csv",
    );
    expect(parsed.rows[0].description).toBe("ROLL-TOP DRY BAG BACKPACK ARMY GREEN&BLACK");
  });

  it("leaves description empty rather than copying the title", async () => {
    // An absent description must report as absent — copying the name in made
    // the report's description comparison meaningless.
    const parsed = await parseVendorFile(
      csv([
        ["SKU", "Title", "UPC"],
        ["A-1", "Widget A", "190204940575"],
      ]),
      "t.csv",
    );
    expect(parsed.rows[0].description).toBeUndefined();
  });

  it("tolerates separators in a genuine barcode column", async () => {
    const parsed = await parseVendorFile(
      csv([
        ["SKU", "Barcode", "Title"],
        ["PART-1", "0-12345-67890-5", "Widget A"],
        ["PART-2", "0-12345-67891-2", "Widget B"],
      ]),
      "t.csv",
    );
    expect(parsed.rows[0].sku).toBe("PART-1");
  });
});
