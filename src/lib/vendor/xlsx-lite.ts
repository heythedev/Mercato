import JSZip from "jszip";

/**
 * Minimal fast xlsx GRID READER (first N rows only).
 * ExcelJS hangs on large files with column-level data validations — this reads
 * straight from the XML without expanding those validations.
 */

export type XlsxGrid = { sheetName: string; grid: string[][] };
export type XlsxSheetGrid = { sheetName: string; grid: string[][]; score: number };

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function textRuns(fragment: string): string {
  let out = "";
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fragment))) out += decodeXml(m[1]);
  return out;
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

const MAX_COLS = 1024;
const SCORE_SCAN_ROWS = 60;

const NAME_POSITIVE = /listing|template|catalog\b|product|items?\b|offers?\b|\bdata\b/i;
const NAME_NEGATIVE =
  /instruction|definition|help|glossary|example|dropdown|valid|values|attribute|meta\b|reference|browse|lookup|notes|read.?me|conditions/i;

function scoreSheet(name: string, grid: string[][]): number {
  let headerIdx = 0;
  let headerCount = 0;
  const scan = Math.min(grid.length, 25);
  for (let i = 0; i < scan; i++) {
    const count = grid[i].filter((c) => String(c ?? "").trim() !== "").length;
    if (count >= 2 && count > headerCount) {
      headerCount = count;
      headerIdx = i;
    }
  }
  if (headerCount < 2) return -1000;
  let dataRowsBelow = 0;
  for (let i = headerIdx + 1; i < grid.length; i++) {
    if (grid[i].some((c) => String(c ?? "").trim() !== "")) dataRowsBelow++;
  }
  const nameBonus = NAME_NEGATIVE.test(name) ? -80 : NAME_POSITIVE.test(name) ? 60 : 0;
  // Reward sheets with more data rows — a large row count is a strong signal this
  // is the product catalog sheet. The old formula PENALISED large row counts which
  // could cause a small helper sheet to outscore a 10k-product sheet.
  const rowBonus = dataRowsBelow > 0 ? Math.min(Math.floor(Math.log10(dataRowsBelow) * 15), 45) : 0;
  return Math.min(headerCount, 120) + nameBonus + rowBonus;
}

async function loadSheets(buffer: Buffer, maxRows: number): Promise<XlsxSheetGrid[]> {
  const zip = await JSZip.loadAsync(buffer);

  const wbXml = await zip.file("xl/workbook.xml")?.async("string");
  if (!wbXml) throw new Error("Not a valid xlsx file (missing workbook.xml).");

  const relsXml = (await zip.file("xl/_rels/workbook.xml.rels")?.async("string")) ?? "";
  const relTargets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\s[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"/g)) {
    relTargets.set(m[1], m[2].replace(/^\/?(xl\/)?/, ""));
  }

  const shared: string[] = [];
  const ssXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (ssXml) {
    const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ssXml))) shared.push(textRuns(m[1]));
  }

  const sheets: XlsxSheetGrid[] = [];
  let sheetIdx = 0;
  for (const m of wbXml.matchAll(/<sheet\s[^>]*>/g)) {
    const name = decodeXml(attr(m[0], "name") ?? `Sheet${sheetIdx + 1}`);
    const rid = attr(m[0], "r:id");
    const target = (rid && relTargets.get(rid)) || `worksheets/sheet${sheetIdx + 1}.xml`;
    sheetIdx++;
    const sheetXml = await zip.file(`xl/${target}`)?.async("string");
    if (!sheetXml) continue;
    const grid = parseSheetRows(sheetXml, shared, maxRows);
    const score = scoreSheet(name, grid);
    console.log(`[xlsx] Sheet "${name}": ${grid.length} rows, score=${score}`);
    sheets.push({ sheetName: name, grid, score });
  }
  return sheets;
}

/** Returns all sheets that look like product data (score above threshold), sorted best-first. */
export async function readAllProductSheets(buffer: Buffer): Promise<XlsxSheetGrid[]> {
  const sheets = await loadSheets(buffer, Number.MAX_SAFE_INTEGER);
  if (!sheets.length) throw new Error("Workbook has no readable sheets.");

  const good = sheets.filter(s => {
    if (s.score > 0) return true;    // clearly a product sheet
    if (s.score <= -1000) return false; // rejected: fewer than 2 header columns

    // A negatively-named sheet ("Reference", "Values", "Attribute", "Notes",
    // "Conditions", etc.) still contains product data if it has substantial rows.
    // Genuine lookup/dropdown/instruction tables are always small (< 100 rows);
    // product sheets are large. Count non-blank rows to decide.
    const nonBlankRows = s.grid.reduce(
      (n, r) => n + (r.some(c => String(c ?? "").trim() !== "") ? 1 : 0), 0,
    );
    return nonBlankRows > 100;
  }).sort((a, b) => b.score - a.score);

  // Fallback: if nothing passed, take whichever sheet scored highest
  const result = good.length ? good : [sheets.reduce((a, b) => b.score > a.score ? b : a)];
  console.log(`[xlsx] Using ${result.length} sheet(s): ${result.map(s => `"${s.sheetName}"(${s.score})`).join(", ")}`);
  return result;
}

/** Legacy single-sheet reader — kept for template parsing where we want exactly one sheet. */
export async function readXlsxGrid(buffer: Buffer, maxRows: number): Promise<XlsxGrid> {
  const sheets = await loadSheets(buffer, maxRows);
  if (!sheets.length) throw new Error("Workbook has no readable sheets.");
  const best = sheets.reduce((a, b) => b.score > a.score ? b : a);
  console.log(`[xlsx] Selected sheet "${best.sheetName}" (score=${best.score}) with ${best.grid.length} rows`);
  return { sheetName: best.sheetName, grid: best.grid.slice(0, maxRows) };
}

function parseSheetRows(sheetXml: string, shared: string[], maxRows: number): string[][] {
  const grid: string[][] = [];
  const rowRe = /<row(\s[^>]*)?>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\s([^>]*?)\/>|<c\s([^>]*)>([\s\S]*?)<\/c>/g;
  let rowM: RegExpExecArray | null;
  while ((rowM = rowRe.exec(sheetXml)) && grid.length < maxRows) {
    const rAttr = attr(`<row ${rowM[1] ?? ""}>`, "r");
    const rowIdx = rAttr ? parseInt(rAttr, 10) - 1 : grid.length;
    if (rowIdx >= maxRows) break;
    while (grid.length < rowIdx) grid.push([]);
    const cells: string[] = [];
    let cellM: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    while ((cellM = cellRe.exec(rowM[2]))) {
      const attrs = cellM[1] ?? cellM[2] ?? "";
      const body = cellM[3] ?? "";
      const ref = attr(`<c ${attrs}>`, "r");
      const letters = ref ? ref.replace(/\d+$/, "") : "";
      const ci = letters ? colIndex(letters) : cells.length;
      if (ci >= MAX_COLS) continue;
      const type = attr(`<c ${attrs}>`, "t");
      let value = "";
      if (type === "inlineStr") {
        value = textRuns(body);
      } else {
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        value = type === "s" ? (shared[parseInt(v, 10)] ?? "") : decodeXml(v);
      }
      while (cells.length < ci) cells.push("");
      cells[ci] = value;
    }
    grid[rowIdx] = cells;
  }
  return grid;
}
