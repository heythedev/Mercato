import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { templateRequirements } from "./zip";

// The requirement matrix decides which cells a category may carry. Asking a
// person — or a model — to supply a value is only safe when the ask is
// limited to the columns that product's OWN category requires: the union of
// every category's columns puts a Seat Height on a Halloween backdrop, into a
// cell the template marks not-applicable and the client's import needs EMPTY.
//
// These build a minimal Mathis-shaped workbook. The "Columns" sheet holds one
// row per attribute; A–D are Code, Label, Description and Value example, and
// the category paths run from column E — the layout the real templates ship.

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

function cell(ref: string, text: string): string {
  return `<c r="${ref}" t="inlineStr"><is><t>${esc(text)}</t></is></c>`;
}

function row(rn: number, cells: (string | null)[]): string {
  return `<row r="${rn}">${cells
    .map((v, i) => (v == null ? "" : cell(`${LETTERS[i]}${rn}`, v)))
    .join("")}</row>`;
}

/** A workbook whose Columns sheet encodes `matrix` over `categories`. */
async function template(
  categories: string[],
  matrix: Record<string, (string | null)[]>,
): Promise<Buffer> {
  const rows = [row(1, ["Code", "Label", "Description", "Value example", ...categories])];
  let r = 2;
  for (const [attr, statuses] of Object.entries(matrix)) {
    rows.push(row(r++, [attr, attr, null, null, ...statuses]));
  }

  const zip = new JSZip();
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Columns" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
</Relationships>`,
  );
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
  );
  zip.file(
    "xl/worksheets/sheet2.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${rows.join("\n")}</sheetData></worksheet>`,
  );
  return zip.generateAsync({ type: "nodebuffer" }) as unknown as Promise<Buffer>;
}

const DINING = "Mathis Home/Furniture/Dining Room/Dining Chairs";
const BACKDROP = "Mathis Home/Seasonal/Halloween/Backdrops";
const CHAIRS = "Furniture > Dining Room > Dining Chairs";
const BACK = "Seasonal > Halloween > Backdrops";

describe("templateRequirements", () => {
  it("asks each category only for the columns it actually requires", async () => {
    const buf = await template([DINING, BACKDROP], {
      "Seat Height": ["REQUIRED", "NA"],
      Material: ["REQUIRED", "REQUIRED"],
      "Bed Size": ["NA", "NA"],
    });
    const req = await templateRequirements(buf, "mathis");
    expect(req).not.toBeNull();

    expect(req!.requires(CHAIRS, "Seat Height")).toBe(true);
    expect(req!.requires(CHAIRS, "Material")).toBe(true);
    expect(req!.requires(CHAIRS, "Bed Size")).toBe(false);

    // the case from the bug report: a seasonal backdrop is not seating
    expect(req!.requires(BACK, "Seat Height")).toBe(false);
    expect(req!.requires(BACK, "Bed Size")).toBe(false);
    expect(req!.requires(BACK, "Material")).toBe(true);
  });

  it("treats RECOMMENDED and OPTIONAL as not required", async () => {
    const buf = await template([DINING], {
      Material: ["RECOMMENDED"],
      Color: ["OPTIONAL"],
      STYLE: ["REQUIRED"],
    });
    const req = await templateRequirements(buf, "mathis");
    expect(req!.requires(CHAIRS, "Material")).toBe(false);
    expect(req!.requires(CHAIRS, "Color")).toBe(false);
    expect(req!.requires(CHAIRS, "STYLE")).toBe(true);
  });

  it("matches a category the matrix accents differently, and the catalogue numbers", async () => {
    // The live templates spell the department "Décor"; the catalogue spells it
    // "Decor 1" / "Decor 2" because Mathis splits it across two templates.
    // Exact matching alone missed a fifth of the live catalogue.
    const buf = await template(["Mathis Home/Décor/Lighting/Chandeliers"], {
      Material: ["REQUIRED"],
      "Seat Height": ["NA"],
    });
    const req = await templateRequirements(buf, "mathis");
    const chandelier = "Decor 1 > Lighting > Chandeliers";
    expect(req!.pathFor(chandelier)).not.toBe("");
    expect(req!.requires(chandelier, "Material")).toBe(true);
    expect(req!.requires(chandelier, "Seat Height")).toBe(false);
  });

  it("keeps two split departments apart — the full path disambiguates", async () => {
    // Decor 1 and Decor 2 fold to the same department, so the rest of the path
    // has to be what decides. A Decor 1 category must not borrow Decor 2's.
    const buf = await template(
      ["Mathis Home/Décor/Lighting/Chandeliers", "Mathis Home/Décor/Window Treatments/Curtains"],
      { "Number of Shelves": ["REQUIRED", "NA"], "Panel Length": ["NA", "REQUIRED"] },
    );
    const req = await templateRequirements(buf, "mathis");
    expect(req!.requires("Decor 1 > Lighting > Chandeliers", "Number of Shelves")).toBe(true);
    expect(req!.requires("Decor 1 > Lighting > Chandeliers", "Panel Length")).toBe(false);
    expect(req!.requires("Decor 2 > Window Treatments > Curtains", "Panel Length")).toBe(true);
    expect(req!.requires("Decor 2 > Window Treatments > Curtains", "Number of Shelves")).toBe(false);
  });

  it("says nothing about a category the matrix does not cover", async () => {
    const buf = await template([DINING], { Material: ["REQUIRED"] });
    const req = await templateRequirements(buf, "mathis");
    // An unknown category yields no path, so the caller keeps its own list
    // rather than narrowing on a guess and hiding a real gap.
    expect(req!.pathFor("Garden > Sheds")).toBe("");
    expect(req!.requires("Garden > Sheds", "Material")).toBe(false);
  });

  it("has no opinion for a marketplace whose templates carry no matrix", async () => {
    const buf = await template([DINING], { Material: ["REQUIRED"] });
    // Walmart and Temu templates ship no Columns sheet; no matrix means no
    // opinion, and the caller must not infer one.
    expect(await templateRequirements(buf, "walmart")).toBeNull();
  });

  it("ignores a workbook with no Columns sheet", async () => {
    const zip = new JSZip();
    zip.file(
      "xl/workbook.xml",
      `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    );
    zip.file(
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>`,
    );
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet><sheetData/></worksheet>`);
    const buf = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
    expect(await templateRequirements(buf, "mathis")).toBeNull();
  });
});
