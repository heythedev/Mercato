import { expect, it, describe } from "vitest";
import JSZip from "jszip";
import { generateSingleTemplateExport } from "./zip";

/**
 * The export, driven the way the Export button drives it.
 *
 * The unit tests beside this one check each rule in isolation and all passed
 * while two things were wrong in the assembled file: descriptions arrive with
 * their HTML already stripped (the exporter does that for Walmart's sake, for
 * every marketplace), and the paragraph wrapper eBay's accepted file uses was
 * therefore never applied. Neither was visible until a real CSV came out of a
 * real zip.
 */

// A trimmed eBay header. Not all 149 columns — the ones the rules touch, plus
// a couple that must be left alone.
const COLUMNS = [
  "SKU", "Localized For", "Variation Specific Name 1", "Variation Specific Value 1",
  "Title", "Product Description", "UPC", "Brand", "Condition", "Measurement System",
  "Channel ID", "Category", "Payment Policy", "Store Category Name 1", "Active",
].map((h) => ({ key: h, label: h, required: false }));

function splitRow(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; continue; }
      quoted = !quoted;
      continue;
    }
    if (c === "," && !quoted) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

const product = {
  id: "p1",
  name: '72" Red Deluxe Mixed Berry',
  vendorSku: "VICK-P240772",
  upc: "734205765975",
  asin: null,
  brand: "Vickerman",
  price: 55.15,
  // Verbatim what Mercato was producing: the vendor site's own Knockout
  // template, whose bound text was never in the HTML.
  description:
    '<h1 class="product-name" data-bind="text: product().name">72" Red Deluxe</h1>'
    + "<p>A Garland rated for indoor use.</p>",
  imageUrl: "https://images.vickerman.com/P240772_1000.jpg",
  marketplaceCategory: "Antiques > Architectural & Garden > Beams",
  categoryPath: null,
  specProductType: null,
  verifyStatus: "ok",
  vendorData: {
    Color: "Red",
    Size: '72"',
    Error: "VICK-P240772 - Restrictrted Keyword found in Title-'' OR Description -'Garland' OR Brand -''.",
  },
  liveData: null,
};

const withComma = {
  ...product,
  id: "p2",
  name: '4"x10yd Blue Velvet',
  vendorSku: "VICK-QK242550",
  description: "Royal Blue Velvet with Gold Trim.",
  marketplaceCategory: "Antiques > Architectural & Garden > Chandeliers, Sconces & Lighting Fixtures",
  vendorData: { Color: "Royal Blue" },
};

async function exportRows(products: unknown[]): Promise<Record<string, string>[]> {
  const buf = await generateSingleTemplateExport(
    products as never,
    { id: "t1", name: "eBay US", columns: COLUMNS, fileFormat: "csv", category: null } as never,
    "ebay",
  );
  const zip = await JSZip.loadAsync(buf);
  const name = Object.keys(zip.files).find((n) => n.endsWith(".csv"))!;
  const csv = await zip.file(name)!.async("string");
  const lines = csv.split("\n");
  const head = splitRow(lines[0]!);
  return lines.slice(1).filter((l) => l.trim()).map((l) => {
    const cells = splitRow(l);
    return Object.fromEntries(head.map((h, i) => [h, cells[i] ?? ""]));
  });
}

describe("an eBay listing file, as the export actually produces it", () => {
  it("writes the category as an id and as a path", async () => {
    const [row] = await exportRows([product]);
    expect(row!["Category"]).toBe("162927");
    expect(row!["Store Category Name 1"]).toBe("Antiques > Architectural & Garden > Beams");
  });

  it("keeps a category whose name contains a comma intact through the CSV", async () => {
    // The comma is inside the value, so the field has to stay quoted in the
    // file while carrying no quote marks in its data. Both at once.
    const rows = await exportRows([product, withComma]);
    expect(rows[1]!["Category"]).toBe("63516");
    expect(rows[1]!["Store Category Name 1"]).toBe(
      "Antiques > Architectural & Garden > Chandeliers, Sconces & Lighting Fixtures",
    );
  });

  it("leaves no quote mark in any cell", async () => {
    const rows = await exportRows([product, withComma]);
    for (const row of rows) {
      for (const [col, val] of Object.entries(row)) {
        expect(String(val), col).not.toContain('"');
      }
    }
    expect(rows[0]!["Title"]).toBe("72 Red Deluxe Mixed Berry");
    expect(rows[1]!["Title"]).toBe("4x10yd Blue Velvet");
  });

  it("writes the constants", async () => {
    const [row] = await exportRows([product]);
    expect(row!["Localized For"]).toBe("en_US");
    expect(row!["Channel ID"]).toBe("EBAY_US");
    expect(row!["Condition"]).toBe("NEW");
    expect(row!["Measurement System"]).toBe("ENGLISH");
    expect(row!["Payment Policy"]).toBe("PayPal:Immediate pay");
    expect(row!["Active"]).toBe("1");
    expect(row!["Variation Specific Name 1"]).toBe("Color");
  });

  it("still fills the per-product columns beside the constants", async () => {
    const [row] = await exportRows([product]);
    expect(row!["SKU"]).toBe("VICK-P240772");
    expect(row!["UPC"]).toBe("734205765975");
    expect(row!["Brand"]).toBe("Vickerman");
    expect(row!["Variation Specific Value 1"]).toBe("Red");
  });

  it("ships a description as a paragraph, not a page fragment", async () => {
    const [row] = await exportRows([product]);
    const desc = row!["Product Description"]!;
    // The Knockout binding is gone.
    expect(desc).not.toContain("data-bind");
    expect(desc).not.toContain("product-name");
    // And it is wrapped the way the accepted file wraps it. This is the bug
    // the unit tests missed: the exporter strips HTML from every description
    // for Walmart's sake, so by the time eBay's rules run there is no markup
    // left to keep — the wrapper has to be put back.
    expect(desc.startsWith("<p>")).toBe(true);
    expect(desc.endsWith("</p>")).toBe(true);
  });

  it("removes the term the channel manager refused, taking it from the file's own error", async () => {
    // Nothing told the export that "Garland" was restricted. It read that out
    // of the Error column the uploaded file carried.
    const [row] = await exportRows([product]);
    expect(row!["Product Description"]!.toLowerCase()).not.toContain("garland");
    expect(row!["Product Description"]).toContain("rated for indoor use");
  });

  it("leaves a product with no error text alone", async () => {
    const [row] = await exportRows([withComma]);
    expect(row!["Product Description"]).toBe("<p>Royal Blue Velvet with Gold Trim.</p>");
  });
});
