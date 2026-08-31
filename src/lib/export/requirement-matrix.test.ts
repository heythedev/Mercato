import { beforeAll, describe, expect, it } from "vitest";
import JSZip from "jszip";
import { dimensionFromText, generateCategoryZip, weightLbFromText, type TemplateRow } from "./zip";

// The Mirakl (Mathis) "Columns" sheet is a requirement matrix: one row per
// attribute, one column per category path, each cell REQUIRED / RECOMMENDED /
// OPTIONAL / NA. The Data sheet's colour coding renders exactly this — pink =
// REQUIRED, grey = NA (must stay EMPTY) — and it differs per category, so the
// export must enforce it per ROW, from each row's own category.
//
// This test builds a minimal two-category Mathis-style template:
//   attribute       Vases      Pillows
//   color           REQUIRED   (blank = grey)
//   FABRIC_COLOR    NA         REQUIRED
// and verifies grey cells are kept empty while missing pink cells are reported
// in Missing_Mandatory_Fields.csv.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function cell(ref: string, text: string, style = false): string {
  return `<c r="${ref}"${style ? ' s="1"' : ""} t="inlineStr"><is><t>${esc(text)}</t></is></c>`;
}

function row(rn: number, cells: (string | null)[], style = false): string {
  const letters = ["A", "B", "C", "D", "E", "F"];
  const xml = cells
    .map((v, i) => (v == null ? "" : cell(`${letters[i]}${rn}`, v, style)))
    .join("");
  return `<row r="${rn}">${xml}</row>`;
}

async function buildTemplate(): Promise<Buffer> {
  const dataSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
${row(1, ["Category", "Shop SKU", "Name", "Color", "Fabric Color", "Made in USA"], true)}
${row(2, ["category", "shopSKU", "name", "color", "FABRIC_COLOR", "MP_MADE_IN_USA"], true)}
</sheetData>
<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="A3:A100"><formula1>"Mathis Home/Decor/Vases,Mathis Home/Decor/Pillows"</formula1></dataValidation></dataValidations>
</worksheet>`;

  const columnsSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
${row(1, ["Code", "Label", "Description", "Value example", "Mathis Home/Decor/Vases", "Mathis Home/Decor/Pillows"])}
${row(2, ["category", "Category", null, null, "REQUIRED", "REQUIRED"])}
${row(3, ["shopSKU", "Shop SKU", null, null, "REQUIRED", "REQUIRED"])}
${row(4, ["name", "Name", null, null, "REQUIRED", "REQUIRED"])}
${row(5, ["color", "Color", null, null, "REQUIRED", null])}
${row(6, ["FABRIC_COLOR", "Fabric Color", null, null, "NA", "REQUIRED"])}
${row(7, ["MP_MADE_IN_USA", "Made in USA", null, null, "REQUIRED", "REQUIRED"])}
</sheetData>
</worksheet>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Columns" sheetId="2" r:id="rId2"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`);
  zip.file("xl/worksheets/sheet1.xml", dataSheet);
  zip.file("xl/worksheets/sheet2.xml", columnsSheet);
  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="1" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`);
  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

function fakeProduct(over: Record<string, unknown>) {
  return {
    id: "p_" + Math.random().toString(36).slice(2, 10),
    name: "Test Product",
    vendorSku: "SKU-1",
    upc: null,
    asin: null,
    brand: "TestBrand",
    price: 19.99,
    description: "Test description.",
    imageUrl: null,
    marketplaceCategory: null,
    categoryPath: null,
    specProductType: null,
    verifyStatus: null,
    vendorData: null,
    liveData: null,
    ...over,
  } as never;
}

/** Read the Data sheet of an output workbook into rowNum → (letter → value). */
async function readDataRows(xlsx: Buffer): Promise<Map<number, Map<string, string>>> {
  const zip = await JSZip.loadAsync(xlsx);
  const ssXml = (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "";
  const ss: string[] = [];
  for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let t = "";
    for (const tm of m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) t += tm[1];
    ss.push(t);
  }
  const sheetXml = (await zip.file("xl/worksheets/sheet1.xml")?.async("string")) ?? "";
  const rows = new Map<number, Map<string, string>>();
  for (const rm of sheetXml.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = new Map<string, string>();
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1], content = cm[2] ?? "";
      const letter = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      if (!letter) continue;
      const v = content.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
      const t = content.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
      const val = /\bt="s"/.test(attrs) && v !== "" ? (ss[parseInt(v, 10)] ?? "") : (t || v);
      if (val !== "") cells.set(letter, val);
    }
    rows.set(parseInt(rm[1], 10), cells);
  }
  return rows;
}

// Mandatory dimensions/weight are often stated in the product wording itself.
// These are the REAL texts from the client's Decor_1 rows that exported blank.
describe("dimensionFromText / weightLbFromText", () => {
  const grass =
    'Nature-Inspired: Lush greenery that fits all decor. Faux tall grass will add a welcome feel. Measuring 24"H x 12"W x 12"D.';
  const plume = '36"-40" - 7-8oz - Medium Ivory Plume Reed Bundle. Sizes vary plant to plant.';

  it("reads axis-labelled dimensions", () => {
    expect(dimensionFromText(grass, "h")).toBe("24");
    expect(dimensionFromText(grass, "w")).toBe("12");
    expect(dimensionFromText(grass, "d")).toBe("12");
  });

  it("takes the lower bound of a leading height range", () => {
    expect(dimensionFromText(plume, "h")).toBe("36");
    expect(dimensionFromText(plume, "w")).toBe(""); // no width stated — stays honest
  });

  it("reads a leading height from stem/bush titles", () => {
    expect(dimensionFromText('24" Red Berry Twig Glitter Spray', "h")).toBe("24");
  });

  it("never mistakes durations for dimensions", () => {
    expect(dimensionFromText("LED lasts up to 12 hours of glow", "h")).toBe("");
    expect(dimensionFromText("ships within 3 days", "d")).toBe("");
  });

  it("converts ounce ranges and pounds to decimal pounds", () => {
    expect(weightLbFromText(plume)).toBe("0.44"); // 7oz lower bound
    expect(weightLbFromText("3.5oz Bunch")).toBe("0.22");
    expect(weightLbFromText("approx 1.5 lb per bundle")).toBe("1.5");
    expect(weightLbFromText("no weight stated")).toBe("");
  });
});

describe("Mathis requirement-matrix enforcement (pink/grey columns)", () => {
  let dataRows: Map<number, Map<string, string>>;
  let reportCsv: string | null;

  beforeAll(async () => {
    const fileData = await buildTemplate();
    const template: TemplateRow = {
      id: "tpl_decor",
      name: "Decor",
      category: "Decor",
      fileFormat: "xlsx",
      columns: ["Category", "Shop SKU", "Name", "Color", "Fabric Color", "Made in USA"]
        .map((key) => ({ key, label: key })),
      fileData,
    };

    const vase = fakeProduct({
      name: "Ceramic Vase",
      vendorSku: "VASE-1",
      marketplaceCategory: "Decor > Vases",
      // FABRIC_COLOR is NA (grey) for Vases — this value must never be written
      vendorData: { FABRIC_COLOR: "Red", color: "Blue" },
    });
    const pillow = fakeProduct({
      name: "Throw Pillow",
      vendorSku: "PIL-1",
      marketplaceCategory: "Decor > Pillows",
      // color's matrix cell is BLANK for Pillows (grey) — must be kept empty;
      // FABRIC_COLOR is REQUIRED (pink) and missing — must be reported.
      vendorData: { color: "Green" },
    });

    const { zip } = await generateCategoryZip([vase, pillow], [template], "mathis");
    const out = await JSZip.loadAsync(zip);
    dataRows = await readDataRows(await out.file("Decor.xlsx")!.async("nodebuffer"));
    reportCsv = (await out.file("Missing_Mandatory_Fields.csv")?.async("string")) ?? null;
  });

  it("writes products with their categories into the data rows", () => {
    expect(dataRows.get(3)?.get("B")).toBe("VASE-1");
    expect(dataRows.get(3)?.get("A")).toBe("Mathis Home/Decor/Vases");
    expect(dataRows.get(4)?.get("B")).toBe("PIL-1");
    expect(dataRows.get(4)?.get("A")).toBe("Mathis Home/Decor/Pillows");
  });

  it("keeps grey (NA) cells empty even when vendor data has a value", () => {
    // Vases: FABRIC_COLOR is NA — the vendor's "Red" must not reach the sheet
    expect(dataRows.get(3)?.get("E") ?? "").toBe("");
  });

  it("treats a blank matrix cell as grey", () => {
    // Pillows: color's matrix cell is blank — the vendor's "Green" stays out
    expect(dataRows.get(4)?.get("D") ?? "").toBe("");
  });

  it("fills pink (REQUIRED) cells where data exists", () => {
    // Vases: color is REQUIRED and the vendor supplied "Blue"
    expect(dataRows.get(3)?.get("D")).toBe("Blue");
  });

  it("fills compliance defaults into empty pink cells (Made in USA → No)", () => {
    // REQUIRED for both categories, no vendor value anywhere — the deterministic
    // fill layer supplies the operator default instead of shipping a blank.
    expect(dataRows.get(3)?.get("F")).toBe("No");
    expect(dataRows.get(4)?.get("F")).toBe("No");
  });

  it("reports rows whose pink cells could not be filled", () => {
    expect(reportCsv).toBeTruthy();
    const lines = (reportCsv ?? "").split("\n");
    const pillowLine = lines.find((l) => l.includes("PIL-1"));
    expect(pillowLine).toContain("Fabric Color");
    // grey attributes never appear as "missing" — color is NA for Pillows
    expect(pillowLine).not.toContain("Color;");
    // auto-filled columns are no longer "missing"
    expect(pillowLine).not.toContain("Made in USA");
    // the vase filled everything its category requires — no report row
    expect(lines.some((l) => l.includes("VASE-1"))).toBe(false);
  });
});
