import { readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * eBay's category list.
 *
 * Two things make eBay different from the marketplaces already here, and both
 * are deliberate in the shape below:
 *
 *   1. eBay identifies a category by a NUMERIC id, and its upload file wants
 *      that id — not the human path. So the id is kept beside the path rather
 *      than discarded, and `ebayCategoryIdForPath` is what the export reaches
 *      for. A path alone is enough to CHOOSE with and not enough to UPLOAD
 *      with, which is exactly the kind of gap that surfaces at the very end.
 *
 *   2. The column shape of eBay's own category export is not fixed — it
 *      differs by site and by how it was pulled. Rather than hard-code one
 *      layout, the reader below takes the first all-numeric column as the id
 *      and joins the remaining non-empty text columns into the path.
 *
 * Until the CSV is supplied this loads nothing, `hasEbayTaxonomy()` is false,
 * and the taxonomy registry refuses to categorise eBay projects. That refusal
 * is the point: an unconstrained run invents categories that do not exist,
 * and eBay rejects the upload rather than quietly mis-filing it.
 */

export type EbayCategory = { id: string | null; path: string };

let cachedRows: EbayCategory[] | null = null;
let cachedPaths: string[] | null = null;
let cachedPromptBlock: string | null = null;
let cachedIdByPath: Map<string, string> | null = null;
let cachedMtime = -1;

function csvPath(): string {
  return join(process.cwd(), "src/lib/ai/data/ebay_categories.csv");
}

function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; continue; }
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) { cols.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  cols.push(current.trim());
  return cols;
}

function clearCaches(): void {
  cachedRows = null;
  cachedPaths = null;
  cachedPromptBlock = null;
  cachedIdByPath = null;
}

/**
 * Every eBay category, id and path, from ebay_categories.csv.
 *
 * Returns [] when the file is absent rather than throwing: a marketplace
 * whose list has not been supplied yet is a state this app is in on purpose,
 * and the registry turns it into a refusal with a reason a person can act on.
 */
export function loadEbayCategories(): EbayCategory[] {
  let mtime: number;
  try {
    mtime = statSync(csvPath()).mtimeMs;
  } catch {
    clearCaches();
    cachedMtime = -1;
    return [];
  }
  if (cachedRows && mtime === cachedMtime) return cachedRows;

  clearCaches();
  cachedMtime = mtime;

  const raw = readFileSync(csvPath(), "utf8");
  const rows: EbayCategory[] = [];
  let headerSkipped = false;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = parseCsvLine(trimmed);

    // The first row is a header when none of its cells is an id and the line
    // names itself as one. Checked once, so a category literally called
    // "Category" further down is not dropped.
    if (!headerSkipped) {
      headerSkipped = true;
      if (/^(category|categoryid|category id|id|level\s*1)\b/i.test(cols[0] ?? "")) continue;
    }

    // The id is the first cell that is nothing but digits. eBay's ids are
    // numeric; a category name never is.
    let id: string | null = null;
    const segments: string[] = [];
    for (const col of cols) {
      if (!col) continue;
      if (id === null && /^\d+$/.test(col)) { id = col; continue; }
      segments.push(col);
    }
    if (!segments.length) continue;

    // A file may ship the path already joined ("Home & Garden > Kitchen") or
    // split one level per column. Both end up the same shape here.
    const path = segments.join(" > ").replace(/\s*>\s*/g, " > ").trim();
    if (!path) continue;
    rows.push({ id, path });
  }

  cachedRows = rows;
  return rows;
}

/** Every leaf path the model may choose from. */
export function loadEbayCategoryPaths(): string[] {
  if (cachedPaths) return cachedPaths;
  cachedPaths = [...new Set(loadEbayCategories().map((r) => r.path))];
  return cachedPaths;
}

/** Whether a real eBay category list has been supplied yet. */
export function hasEbayTaxonomy(): boolean {
  try {
    return loadEbayCategoryPaths().length > 0;
  } catch {
    return false;
  }
}

/**
 * The numeric eBay category id for a chosen path, or null when the supplied
 * CSV carries no ids. Null is not an error here — some exports of the
 * category list are names only — but a null reaching the upload file is, and
 * that is the caller's call to make, not this one's.
 */
export function ebayCategoryIdForPath(path: string): string | null {
  if (!cachedIdByPath) {
    // Load BEFORE the map exists, not into it. loadEbayCategories clears
    // every cache on a miss — including this one — so a map assigned first
    // was set to null underneath the loop that was filling it, and the next
    // write threw on a cold cache. Which is every cold start in production.
    const rows = loadEbayCategories();
    const byPath = new Map<string, string>();
    for (const r of rows) {
      if (r.id && !byPath.has(r.path)) byPath.set(r.path, r.id);
    }
    cachedIdByPath = byPath;
  }
  return cachedIdByPath.get(String(path ?? "").trim()) ?? null;
}

export function clearEbayCache(): void {
  clearCaches();
  cachedMtime = -1;
}

/** The category list rendered for the categorization prompt, grouped by its
 *  top level so the model sees structure rather than a flat wall of paths. */
export function formatEbayTaxonomyForPrompt(): string {
  if (cachedPromptBlock) return cachedPromptBlock;

  const paths = loadEbayCategoryPaths();
  const byTop = new Map<string, string[]>();

  for (const path of paths) {
    const top = path.split(" > ")[0] ?? path;
    const rest = path.slice(top.length + 3);
    if (!byTop.has(top)) byTop.set(top, []);
    byTop.get(top)!.push(rest);
  }

  const lines: string[] = [];
  for (const [top, leaves] of byTop) {
    lines.push(`${top}:`);
    lines.push(leaves.filter(Boolean).map((l) => `  - ${top} > ${l}`).join("\n"));
    lines.push("");
  }

  cachedPromptBlock = lines.join("\n").trim();
  return cachedPromptBlock;
}
