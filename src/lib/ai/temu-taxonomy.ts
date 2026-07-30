import { readFileSync, statSync } from "fs";
import { join } from "path";

/** Full Temu path: "Category > Subcategory > Sub-Subcategory" */
export type TemuCategoryPath = string;

let cachedPaths: TemuCategoryPath[] | null = null;
let cachedPromptBlock: string | null = null;
let cachedMtime = 0;

function csvPath(): string {
  return join(process.cwd(), "src/lib/ai/data/temu_categories.csv");
}

/** Proper quoted-CSV line parser — handles fields that contain commas. */
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

/** Load and cache every leaf path from temu_categories.csv.
 *  Automatically reloads if the CSV file has been modified on disk
 *  so no server restart or admin endpoint call is needed after a CSV update. */
export function loadTemuCategoryPaths(): TemuCategoryPath[] {
  const mtime = statSync(csvPath()).mtimeMs;
  if (cachedPaths && mtime === cachedMtime) return cachedPaths;

  // CSV changed on disk (or first load) — invalidate and reload
  cachedPaths = null;
  cachedPromptBlock = null;
  cachedMtime = mtime;

  const raw = readFileSync(csvPath(), "utf8");
  const paths: TemuCategoryPath[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith("category,")) continue;
    const cols = parseCsvLine(trimmed);
    const [category, subcategory, subSub] = cols;
    if (!category || !subcategory || !subSub) continue;
    paths.push(`${category} > ${subcategory} > ${subSub}`);
  }

  if (paths.length === 0) {
    throw new Error("temu_categories.csv is empty or could not be parsed");
  }

  cachedPaths = paths;
  return cachedPaths;
}

/** Clear cached taxonomy data so next call reloads from disk (use after CSV update). */
export function clearTemuCache(): void {
  cachedPaths = null;
  cachedPromptBlock = null;
}

/**
 * Format the taxonomy for the Claude prompt, grouped by top-level category so
 * the model can scan it efficiently. Scales to the full CSV — replacing
 * temu_categories.csv with a larger export needs no code change (the loader
 * auto-reloads on file mtime, and the sheet is prompt-cached per marketplace).
 */
export function formatTemuTaxonomyForPrompt(): string {
  if (cachedPromptBlock) return cachedPromptBlock;

  const paths = loadTemuCategoryPaths();
  const byTop = new Map<string, string[]>();

  for (const path of paths) {
    const top = path.split(" > ")[0] ?? path;
    const rest = path.slice(top.length + 3); // after "Top > "
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
