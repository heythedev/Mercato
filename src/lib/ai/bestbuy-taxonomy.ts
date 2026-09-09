import { readFileSync, statSync } from "fs";
import { join } from "path";

/** Full Best Buy path: "Category > Subcategory > Sub-Subcategory" */
export type BestBuyCategoryPath = string;

let cachedPaths: BestBuyCategoryPath[] | null = null;
let cachedPromptBlock: string | null = null;
let cachedMtime = 0;

function csvPath(): string {
  return join(process.cwd(), "src/lib/ai/data/bestbuy_categories.csv");
}

function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { cols.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  cols.push(current.trim());
  return cols;
}

/** Leaf path → Mirakl hierarchy code. The code, not the label, is what the
 *  attribute lookup (PM11) and Mirakl's product import both key on. */
let cachedCodeByPath: Map<string, string> | null = null;

/** Load and cache every leaf path from bestbuy_categories.csv.
 *  Automatically reloads if the CSV file has been modified.
 *
 *  Best Buy's real tree (pulled from Mirakl H11 by
 *  scripts/fetch-bestbuy-taxonomy.ts) is 4 levels and RAGGED — of its 1,450
 *  leaves, 666 sit at depth 4, 772 at depth 3 and 12 at depth 2. The old
 *  parser required exactly three non-empty columns, which silently dropped
 *  every leaf that wasn't depth-3 and truncated the deeper ones. Depth is
 *  therefore taken from however many level columns a row actually fills. */
export function loadBestBuyCategoryPaths(): BestBuyCategoryPath[] {
  const mtime = statSync(csvPath()).mtimeMs;
  if (cachedPaths && mtime === cachedMtime) return cachedPaths;

  cachedPaths = null;
  cachedPromptBlock = null;
  cachedCodeByPath = new Map();
  cachedMtime = mtime;

  const raw = readFileSync(csvPath(), "utf8");
  const paths: BestBuyCategoryPath[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith("category,")) continue;
    const cols = parseCsvLine(trimmed);
    // Trailing column is the Mirakl code when present (5-column format); the
    // legacy 3-column file has no code and still loads.
    const hasCode = cols.length >= 5;
    const levels = (hasCode ? cols.slice(0, 4) : cols).map((c) => c.trim()).filter(Boolean);
    if (levels.length < 2) continue; // a bare top-level node is not a listable category
    const path = levels.join(" > ");
    paths.push(path);
    const code = hasCode ? cols[4]?.trim() : "";
    if (code) cachedCodeByPath.set(path, code);
  }

  if (paths.length === 0) {
    throw new Error("bestbuy_categories.csv is empty or could not be parsed");
  }

  cachedPaths = paths;
  return cachedPaths;
}

export function clearBestBuyCache(): void {
  cachedPaths = null;
  cachedPromptBlock = null;
  cachedCodeByPath = null;
}

/**
 * The Mirakl hierarchy code for an assigned category path — the key PM11 and
 * Mirakl's product import need. Null for the legacy CSV (no code column) or an
 * unrecognised path.
 */
export function bestBuyCodeForPath(path: string): string | null {
  loadBestBuyCategoryPaths(); // populates cachedCodeByPath
  return cachedCodeByPath?.get(path.trim()) ?? null;
}

export function formatBestBuyTaxonomyForPrompt(): string {
  if (cachedPromptBlock) return cachedPromptBlock;

  const paths = loadBestBuyCategoryPaths();
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
    lines.push(leaves.map((l) => `  - ${top} > ${l}`).join("\n"));
    lines.push("");
  }

  cachedPromptBlock = lines.join("\n").trim();
  return cachedPromptBlock;
}
