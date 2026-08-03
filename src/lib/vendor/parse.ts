import { readAllProductSheets } from "./xlsx-lite";
import { ASIN_RE, toDisplayBarcode } from "@/lib/barcode";

export type VendorRow = {
  name: string;
  sku?: string;
  upc?: string;
  asin?: string;
  brand?: string;
  description?: string;
  dimensions?: string;
  imageUrl?: string;
  price?: number;
  discontinued?: boolean;
  [key: string]: unknown;
};

const MAX_FILE_COLS = 256;
const HEADER_SCAN_ROWS = 25;

const BARCODE_RE = /^\d{8,14}$/;

function isBarcode(v: string): boolean {
  return BARCODE_RE.test(v) || BARCODE_RE.test(toDisplayBarcode(v) ?? "");
}

function columnShare(rows: string[][], col: number, test: (v: string) => boolean): number {
  let seen = 0;
  let hit = 0;
  for (const r of rows) {
    const v = (r[col] ?? "").trim();
    if (!v) continue;
    seen++;
    if (test(v)) hit++;
  }
  return seen ? hit / seen : 0;
}

function findHeader(headers: string[], re: RegExp, taken: Set<number>): number | null {
  for (let i = 0; i < headers.length; i++) {
    if (!taken.has(i) && re.test(headers[i])) return i;
  }
  return null;
}

function findHeaderLoose(headers: string[], re: RegExp, taken: Set<number>): number | null {
  for (let i = 0; i < headers.length; i++) {
    if (!taken.has(i) && re.test(headers[i].replace(/[_-]/g, " "))) return i;
  }
  return null;
}

type ColMap = {
  asinCol: number | null;
  codeCol: number | null;
  brandCol: number | null;
  productCol: number | null;
  vendorSkuCol: number | null;
  descriptionCol: number | null;
  dimensionsCol: number | null; // explicit combined "Dimensions" column
  lengthCol: number | null;     // first "Length" column (individual item)
  widthCol: number | null;      // first "Width" column (individual item)
  heightCol: number | null;     // first "Height" or "Depth" column (individual item)
  imageCol: number | null;      // image URL column
  priceCol: number | null;
  statusCol: number | null;     // product status / active / discontinued column
};

/**
 * Score all candidate SKU columns and return the best one.
 *
 * Priority layers (highest wins):
 *  1. Header name specificity  – "Vendor SKU" > bare "SKU" > "Item No" > "Key Field"
 *  2. Value uniqueness         – a real SKU has few duplicates
 *  3. Format quality           – alphanumeric codes, consistent length, not pure digits
 *  4. Marketplace-prefix penalty – "APSA-*", "FBA-*" etc. are listing IDs, not vendor codes
 */
function pickBestSkuCol(headers: string[], sample: string[][], taken: Set<number>): number | null {
  type Candidate = { idx: number; score: number };
  const candidates: Candidate[] = [];

  for (let i = 0; i < headers.length; i++) {
    if (taken.has(i)) continue;
    const h = headers[i].replace(/[_-]/g, " ");

    let headerScore = 0;
    // Tier 1 – exact "SKU" (client instruction: always prefer the column literally named SKU)
    if (/^sku$/i.test(h)) headerScore = 100;
    // Tier 2 – explicit vendor/supplier/seller/internal prefix
    else if (/\b(?:factory|vendor|supplier|seller|internal|our|your)\s+sku\b/i.test(h)) headerScore = 90;
    // Tier 3 – "Item No", "Style #", "Part No", "Product Code", "Catalog No", etc.
    else if (/\b(?:item|article|style|model|part|ref(?:erence)?|product|stock|catalog|cat|collection|design|pattern)\s*(?:no\.?|num(?:ber)?|code|id|#)\b/i.test(h)) headerScore = 60;
    // Tier 4 – very generic ("Key Field") — last resort
    else if (/\bkey\s*field\b/i.test(h)) headerScore = 20;
    else continue; // not a SKU candidate at all

    const vals = sample.map(r => (r[i] ?? "").trim()).filter(Boolean);
    if (!vals.length) continue;

    // Uniqueness: a true SKU column should have near-100% distinct values
    const uniqueness = new Set(vals).size / vals.length; // 0–1
    const uniquenessScore = uniqueness * 25;

    // Format quality: values should look like product codes (alphanumeric, 3–30 chars, not pure numbers)
    const formatShare = columnShare(sample, i, (v) =>
      /^[A-Z0-9][A-Z0-9\-_.]{2,29}$/i.test(v) && !/^\d{8,}$/.test(v),
    );
    const formatScore = formatShare * 20;

    // Global-identifier penalty. A column of ASINs or barcodes identifies the PRODUCT,
    // not the seller's item — it is never a shop SKU, even when the vendor headed it
    // "SKU". These sheets are common (Amazon-sourced catalogues), and without this the
    // literal-"SKU" header score of 100 made an ASIN column win outright.
    const globalIdShare = columnShare(sample, i, (v) => ASIN_RE.test(v) || isBarcode(v));
    if (globalIdShare >= 0.6) continue; // disqualify outright

    const total = headerScore + uniquenessScore + formatScore;
    candidates.push({ idx: i, score: total });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  taken.add(best.idx);
  return best.idx;
}

function detectColumns(headers: string[], sample: string[][]): ColMap {
  const taken = new Set<number>();
  const claim = (i: number | null) => { if (i != null) taken.add(i); return i; };

  // ASIN — "asin", "child_asin", "asins" but NOT "parent_asin"
  let asinCol = claim(findHeaderLoose(headers, /^asins?$|\bchild\s+asin\b/i, taken));
  if (asinCol == null) asinCol = claim(findHeaderLoose(headers, /(?<!parent\s)\basin\b/i, taken));

  // UPC / EAN / barcode
  let codeCol = claim(findHeader(headers, /\b(upc|ean|gtin|barcode|isbn)\b/i, taken));

  // Vendor SKU — multi-candidate scoring instead of first-match-left-to-right
  const vendorSkuCol = pickBestSkuCol(headers, sample, taken);

  // Brand / manufacturer
  const brandCol = claim(findHeader(headers, /\b(brand|manufacturer|maker)\b/i, taken));

  // Product name (title/name/product wins; description only if nothing better)
  const productCol = claim(findHeaderLoose(
    headers,
    /\b(?:product|item|title)\b|\bname\b|\bdescription\b/i,
    taken,
  ));

  // Long description — claimed AFTER productCol
  const descriptionCol = claim(findHeaderLoose(
    headers,
    /\b(?:description|desc|details?|notes?|specifications?|specs?|long)\b/i,
    taken,
  ));

  // Dimensions — explicit combined column only (NOT length/width/height — those are separate)
  const dimensionsCol = claim(findHeaderLoose(
    headers,
    /\b(?:dimensions?|dims?|package[\s_-]*(?:size|dims?)|product[\s_-]*size)\b/i,
    taken,
  ));
  // First occurrence of individual L/W/H columns (before master-package columns overwrite them)
  const lengthCol = claim(findHeader(headers, /\blength\b/i, taken));
  const widthCol  = claim(findHeader(headers, /\bwidth\b|\bwide\b/i, taken));
  const heightCol = claim(findHeader(headers, /\bheight\b|\bdepth\b/i, taken));

  // Image URL
  const imageCol = claim(findHeaderLoose(
    headers,
    /\b(?:image[\s_-]*(?:url|link|src|path)?|img[\s_-]*(?:url|link)?|photo[\s_-]*(?:url|link)?|picture[\s_-]*(?:url|link)?|thumbnail[\s_-]*(?:url|link)?)\b/i,
    taken,
  ));

  // Price
  const priceCol = claim(findHeader(
    headers,
    /\b(price|unit[\s_-]*price|wholesale|cost|msrp|list[\s_-]*price)\b/i,
    taken,
  ));

  // Product status / active / discontinued indicator column
  const statusCol = claim(findHeader(
    headers,
    /\b(status|item[\s_-]*status|product[\s_-]*status|active|availability|available|disc(?:ontinued)?)\b/i,
    taken,
  ));

  // Cell-shape sniffing for ASIN / UPC when headers didn't match
  if (asinCol == null) {
    for (let i = 0; i < headers.length; i++) {
      if (!taken.has(i) && columnShare(sample, i, (v) => ASIN_RE.test(v)) >= 0.6) {
        asinCol = i; taken.add(i); break;
      }
    }
  }
  if (codeCol == null) {
    for (let i = 0; i < headers.length; i++) {
      if (!taken.has(i) && columnShare(sample, i, isBarcode) >= 0.6) {
        codeCol = i; taken.add(i); break;
      }
    }
  }

  return { asinCol, codeCol, brandCol, productCol, vendorSkuCol, descriptionCol, dimensionsCol, lengthCol, widthCol, heightCol, imageCol, priceCol, statusCol };
}

function pickHeaderRow(grid: string[][]): number {
  let best = 0;
  let bestCount = -1;
  const scan = Math.min(grid.length, HEADER_SCAN_ROWS);
  for (let i = 0; i < scan; i++) {
    const count = grid[i].filter((c) => String(c ?? "").trim() !== "").length;
    if (count >= 2 && count > bestCount) {
      bestCount = count;
      best = i;
    }
  }
  return best;
}

function toNumber(v: string): number | undefined {
  if (!v) return undefined;
  const n = Number(v.replace(/[$,\s]/g, ""));
  return isNaN(n) ? undefined : n;
}

function gridToRows(grid: string[][]): VendorRow[] {
  const headerIdx = pickHeaderRow(grid);
  const rawHeaders = (grid[headerIdx] ?? []).slice(0, MAX_FILE_COLS);
  let width = rawHeaders.length;
  while (width > 0 && String(rawHeaders[width - 1] ?? "").trim() === "") width--;
  width = Math.max(width, 1);

  // ── Multi-row header detection ──────────────────────────────────────────────
  // Some vendor files have a GROUP LABEL row ("INDIVIDUAL ITEM APPROX. DIMs & WEIGHTS")
  // above a SUB-LABEL row ("Length", "Width", "Height").
  // Detect this and merge both rows into one effective header so L/W/H are recognized.
  const subRow = (grid[headerIdx + 1] ?? []).slice(0, MAX_FILE_COLS).map(c => String(c ?? "").trim());
  // Sub-header row is confirmed when it contains ≥2 pure dimension/quantity column names
  const SUB_LABEL_RE = /^(length|width|height|depth|weight|qty|quantity|uom|unit)$/i;
  const GROUP_LABEL_RE = /\b(approx|master|package|individual|item|dims?|weights?|lbs?|inches|carton)\b/i;
  const hasSubHeader = subRow.filter(v => SUB_LABEL_RE.test(v)).length >= 2;

  // ── Field-code header row detection ─────────────────────────────────────────
  // Mathis (and other Mirakl-style) templates repeat the header twice:
  //   Row 1 = human labels       ("Product", "SKU", "UPC", "Brand")
  //   Row 2 = internal field ids ("name",    "sku", "UPC", "brand")  ← NOT a product
  // The second row would otherwise be imported as a product literally named "name".
  // It is identified by being a near-duplicate of the header row: most of its
  // non-blank cells collapse to the same token as the header cell above them,
  // or are themselves well-known field-code words.
  const FIELD_CODE_RE = /^(name|title|sku|shopsku|upc|ean|gtin|barcode|brand|manufacturer|description|price|category|image|imageurl|qty|quantity|asin|model|color|colour|size|material|weight|length|width|height|depth)$/i;
  const collapseCell = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const isFieldCodeRow = (() => {
    const headerCells = rawHeaders.slice(0, width).map(h => String(h ?? "").trim());
    let compared = 0;
    let matched = 0;
    for (let i = 0; i < width; i++) {
      const sub = subRow[i] ?? "";
      if (!sub) continue;
      compared++;
      const subC = collapseCell(sub);
      const headC = collapseCell(headerCells[i] ?? "");
      // Same token as the label above (Product/product, SKU/sku, UPC/UPC) or a known field code
      if ((headC && subC === headC) || FIELD_CODE_RE.test(sub)) matched++;
    }
    // Need a few cells to judge, and the clear majority must look like field codes
    return compared >= 3 && matched / compared >= 0.6;
  })();

  const headers: string[] = rawHeaders.slice(0, width).map((h, i) => {
    const main = String(h ?? "").trim();
    if (hasSubHeader) {
      const sub = subRow[i] ?? "";
      // Replace blank or group-label cells with the sub-label (e.g. blank → "Length")
      if (sub && (!main || GROUP_LABEL_RE.test(main))) return sub;
    }
    return main;
  });

  // Data rows start after header (and sub-header / field-code row if one was consumed)
  const dataStartIdx = (hasSubHeader || isFieldCodeRow) ? headerIdx + 2 : headerIdx + 1;

  // Extend width if data rows contain values beyond the last non-blank header column.
  // This handles files where some product columns sit under blank header cells.
  const widthCheckEnd = Math.min(grid.length, dataStartIdx + 51);
  for (let i = dataStartIdx; i < widthCheckEnd; i++) {
    const r = grid[i] ?? [];
    const rLen = Math.min(r.length, MAX_FILE_COLS);
    for (let j = rLen - 1; j >= width; j--) {
      if (String(r[j] ?? "").trim() !== "") {
        while (headers.length < j + 1) headers.push("");
        width = j + 1;
        break;
      }
    }
  }

  // Build data rows (rows below header, non-blank)
  const dataRows: string[][] = [];
  for (let i = dataStartIdx; i < grid.length; i++) {
    const row = (grid[i] ?? []).slice(0, width).map((c) => String(c ?? "").trim());
    if (row.every((c) => c === "")) continue;
    while (row.length < width) row.push("");
    dataRows.push(row);
  }

  console.log(`[parse] Grid: ${grid.length} total rows, header at row ${headerIdx}, width=${width}, data starts at row ${dataStartIdx}, ${dataRows.length} non-blank data rows`);
  if (!dataRows.length) return [];

  const cols = detectColumns(headers, dataRows.slice(0, 50));

  let filteredNoName = 0;
  let filteredFieldCode = 0;
  let filteredPolicy = 0;

  const parsed = dataRows.map((row) => {
    const get = (idx: number | null): string => (idx != null ? row[idx] ?? "" : "").trim();

    // Build raw vendorData — FIRST-WINS for duplicate column names so individual item dims
    // (which appear before master-package dims in the spreadsheet) always take priority.
    // e.g. two "Length" columns → raw["Length"] = individual item length, master is ignored.
    const raw: Record<string, unknown> = {};
    const seenCols = new Set<string>();
    headers.forEach((h, i) => {
      if (!h || seenCols.has(h)) return;
      seenCols.add(h);
      raw[h] = row[i] ?? "";
    });

    // If productCol value is a bare 1-2 digit number (pack count, item count, etc.),
    // it's the wrong column — fall through to the description column instead.
    const rawProductVal = get(cols.productCol);
    const isPureShortNumber = /^\d{1,2}$/.test(rawProductVal);
    const name = (!isPureShortNumber ? rawProductVal : null)
      || get(cols.descriptionCol)
      || headers.map((_, i) => row[i]).find((v) => v && v.trim().length > 2)
      || rawProductVal
      || "";

    if (!name) { filteredNoName++; return null; }

    // Safety net for repeated/echoed header rows anywhere in the sheet: a product
    // whose name is a bare field code ("name", "title", "sku") is a header, not a product.
    if (FIELD_CODE_RE.test(name.trim())) { filteredFieldCode++; return null; }

    // Filter out footer/legal text rows (T&C lines, policy disclaimers, etc.)
    const nonBlankCells = row.filter(c => c && c.trim()).length;
    const wordCount = name.split(/\s+/).filter(w => w.length > 2).length;
    const looksLikeSentence =
      (name.trimEnd().endsWith(".") && name.split(/\s+/).length > 5) ||
      wordCount > 7;
    // Keywords that appear in policy/terms text but never in product names
    const hasPolicyWords = /\b(must\s+be|require[sd]?\s+(auth|writ)|claims?\s+for\s+(defective|missing)|shipment\s+fee|drop\s+ship|\bfob\b|subject\s+to\s+change|without\s+notice|\d+\s+days?\s+of\s+(receipt|delivery)|minimum\s+(initial\s+)?order|net\s+(price|fob)|accessories\s+excluded|dealer\s+to\s+qual)\b/i.test(name);
    if (hasPolicyWords || (looksLikeSentence && (nonBlankCells <= 2 || wordCount > 12))) { filteredPolicy++; return null; }

    return {
      ...raw,
      name,
      sku: get(cols.vendorSkuCol) || undefined,
      upc: toDisplayBarcode(get(cols.codeCol)) || get(cols.codeCol) || undefined,
      asin: get(cols.asinCol) || undefined,
      brand: get(cols.brandCol) || undefined,
      description: get(cols.descriptionCol) || get(cols.productCol) || undefined,
      dimensions: (() => {
        // Prefer an explicit combined "Dimensions" column if it contains multiple numbers (e.g. "18 x 14 x 6")
        const explicit = get(cols.dimensionsCol);
        if (explicit && (explicit.match(/\d/g) ?? []).length >= 2) return explicit;
        // Fall back to combining the first L/W/H columns (individual item package dims)
        const l = get(cols.lengthCol);
        const w = get(cols.widthCol);
        const h = get(cols.heightCol);
        const parts = [l, w, h].filter(v => v && !isNaN(parseFloat(v)) && parseFloat(v) > 0);
        if (parts.length >= 2) return parts.join(" x ");
        return explicit || undefined;
      })(),
      imageUrl: get(cols.imageCol) || undefined,
      price: toNumber(get(cols.priceCol)),
      discontinued: (() => {
        if (cols.statusCol == null) return undefined;
        const v = get(cols.statusCol).toLowerCase();
        if (!v) return undefined;
        // Explicit discontinued values
        if (/^(d|dc|disc|discontinued|inactive|obsolete|delisted|n|no|false|0)$/.test(v)) return true;
        // Explicit active values → not discontinued
        if (/^(a|active|y|yes|true|1|available|in[\s_-]*stock)$/.test(v)) return false;
        return undefined;
      })(),
    } as VendorRow;
  }).filter((r): r is VendorRow => r !== null && r.name.length > 0);
  console.log(`[parse] Filtered: no-name=${filteredNoName}, field-code=${filteredFieldCode}, policy=${filteredPolicy}`);
  console.log(`[parse] Final: ${parsed.length} valid products (${dataRows.length - parsed.length} filtered out)`);
  return parsed;
}

// ── CSV ────────────────────────────────────────────────────────────────────────

function parseCsvLine(line: string, delimiter = ","): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === delimiter && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  result.push(current.trim());
  return result;
}

function detectDelimiter(line: string): string {
  const counts = { ",": 0, "\t": 0, ";": 0, "|": 0 };
  for (const ch of line) if (ch in counts) counts[ch as keyof typeof counts]++;
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0]) ?? ",";
}

function parseCsv(buffer: Buffer): VendorRow[] {
  const text = buffer.toString("utf-8").replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  const delim = detectDelimiter(lines[0] ?? "");
  const grid = lines.map((l) => parseCsvLine(l, delim));
  return gridToRows(grid);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function parseVendorFile(buffer: Buffer, filename: string): Promise<VendorRow[]> {
  const ext = filename.split(".").pop()?.toLowerCase();

  if (ext === "csv" || ext === "tsv" || ext === "txt") {
    return parseCsv(buffer);
  }

  try {
    const sheets = await readAllProductSheets(buffer);
    // Parse each sheet independently (each has its own header row) then combine.
    // Deduplicate by vendorSku so products that appear in multiple sheets aren't doubled.
    const combined: VendorRow[] = [];
    const seenSkus = new Set<string>();
    for (const sheet of sheets) {
      const rows = gridToRows(sheet.grid);
      for (const r of rows) {
        if (r.sku) {
          if (seenSkus.has(r.sku)) continue;
          seenSkus.add(r.sku);
        }
        combined.push(r);
      }
    }
    console.log(`[parse] Combined ${sheets.length} sheet(s) → ${combined.length} total products`);
    return combined;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Couldn't")) throw err;
    throw new Error(
      `Couldn't read "${filename}" — please save it as .xlsx or .csv and upload again.`,
    );
  }
}
