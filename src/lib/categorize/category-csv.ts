/**
 * Parser for the categorize step's download → edit → upload CSV round-trip.
 *
 * Two shapes exist:
 *  - OLD (all marketplaces until the Walmart level-3 work): "Product Type" is
 *    really the level-2 GROUP, re-joined into "Category > Group".
 *  - NEW (Walmart): an explicit "Product Type Group" column carries level 2,
 *    and "Product Type" is the REAL taxonomy level 3 (specProductType) —
 *    never part of the category path.
 * The presence of the "Product Type Group" header is the format switch, so old
 * files keep importing exactly as before and can never leak a group into
 * specProductType.
 *
 * Extracted from the route so both formats are unit-testable, and upgraded to
 * a proper quoted-CSV parser — the old inline `line.split(delim)` broke on any
 * product name or category containing a comma.
 */

export type CategoryCsvRow = {
  sku: string;
  name: string;
  /** Re-joined "Category > Group" (or the verbatim old-format value). */
  category: string;
  path: string | null;
  /** Real level-3 Product Type — only from new-format files; NOT yet validated. */
  specProductType: string | null;
};

export type CategoryCsvResult = {
  rows: CategoryCsvRow[];
  hasGroupColumn: boolean;
  error?: string;
};

/** Quote-aware split ("Home Decor, Kitchen, & Other" stays one cell). */
function splitLine(line: string, delim: string): string[] {
  const cols: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQ = !inQ;
      continue;
    }
    if (ch === delim && !inQ) { cols.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

export function parseCategoryCsv(raw: string): CategoryCsvResult {
  const text = raw.replace(/^﻿/, "");
  const delim = text.includes("\t") ? "\t" : ",";
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const [headerLine, ...dataLines] = lines;
  const headers = splitLine(headerLine ?? "", delim).map((h) => h.toLowerCase());

  const skuIdx = headers.findIndex((h) => /sku|sku_id|vendor_sku|item_sku/.test(h));
  const nameIdx = headers.findIndex((h) => /product[\s_]?name|name|title/.test(h));
  const catIdx = headers.findIndex((h) => /^category$|marketplace[\s_]?cat/.test(h));
  const groupIdx = headers.findIndex((h) => /^product[\s_]?type[\s_]?group$/.test(h));
  const ptIdx = headers.findIndex((h) => /^product[\s_]?type$/.test(h));
  const pathIdx = headers.findIndex((h) => /category[\s_]?path|^path$/.test(h));

  if (catIdx === -1) {
    return { rows: [], hasGroupColumn: false, error: "CSV must have a 'Category' column" };
  }
  const hasGroupColumn = groupIdx !== -1;

  const rows: CategoryCsvRow[] = [];
  for (const line of dataLines) {
    const cols = splitLine(line, delim);
    const cell = (i: number) => (i >= 0 ? (cols[i] ?? "").trim() : "");
    let category = cell(catIdx);
    const pt = cell(ptIdx);
    let specProductType: string | null = null;

    if (hasGroupColumn) {
      const group = cell(groupIdx);
      if (group && !category.includes(" > ")) category = `${category} > ${group}`;
      specProductType = pt || null;
    } else if (pt && !category.includes(" > ")) {
      // Old format: "Product Type" is the level-2 group.
      category = `${category} > ${pt}`;
    }
    if (!category) continue;

    rows.push({
      sku: cell(skuIdx),
      name: cell(nameIdx),
      category,
      path: cell(pathIdx) || null,
      specProductType,
    });
  }
  return { rows, hasGroupColumn };
}
