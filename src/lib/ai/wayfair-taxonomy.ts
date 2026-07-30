import { readFileSync, statSync } from "fs";
import { join } from "path";

/**
 * Wayfair organizes its catalog into numbered *classes* (e.g. "6115 - Luggage Racks").
 * Each class has its own product-upload template workbook, so the class is both the
 * categorization target AND the export grouping key (one output file per class).
 *
 * A Wayfair category path is rendered as "Class Code - Class Name" to mirror the
 * class-sheet naming inside the Wayfair Product Addition Template.
 */
export type WayfairCategoryPath = string;

let cachedPaths: WayfairCategoryPath[] | null = null;
let cachedPromptBlock: string | null = null;
let cachedMtime = 0;

function csvPath(): string {
  return join(process.cwd(), "src/lib/ai/data/wayfair_categories.csv");
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

/**
 * Load and cache every Wayfair class path from wayfair_categories.csv.
 *
 * ⚠️ SOURCE-OF-TRUTH GUARD: this CSV MUST be populated from Wayfair's real
 * class taxonomy/spec. It ships header-only on purpose so categorization fails
 * loudly rather than silently inventing home-goods categories — that invented
 * taxonomy is exactly what caused the previous Wayfair integration to be reverted
 * (commit d677cf7 → ca755ad). Do NOT hardcode category names here or in the
 * categorize prompt; drop the real class list into the CSV instead.
 *
 * CSV shape: "Class Code,Class Name" (e.g. 6115,Luggage Racks).
 *
 * Reloads automatically when the CSV changes on disk (mtime check), so no server
 * restart is needed after the real taxonomy lands.
 */
export function loadWayfairCategoryPaths(): WayfairCategoryPath[] {
  const mtime = statSync(csvPath()).mtimeMs;
  if (cachedPaths && mtime === cachedMtime) return cachedPaths;

  // CSV changed on disk (or first load) — invalidate and reload
  cachedPaths = null;
  cachedPromptBlock = null;
  cachedMtime = mtime;

  const raw = readFileSync(csvPath(), "utf8");
  const paths: WayfairCategoryPath[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Skip comment lines (used in the placeholder CSV) and the header row.
    if (trimmed.startsWith("#")) continue;
    if (/^class\s*code\s*,/i.test(trimmed)) continue;
    const cols = parseCsvLine(trimmed);
    const [code, name] = cols;
    if (!code || !name) continue;
    paths.push(`${code} - ${name}`);
  }

  if (paths.length === 0) {
    throw new Error(
      "wayfair_categories.csv has no class rows. Populate it from Wayfair's real " +
      "class taxonomy (shape: 'Class Code,Class Name', e.g. 6115,Luggage Racks) " +
      "before running Wayfair categorization — do NOT invent categories.",
    );
  }

  cachedPaths = paths;
  return cachedPaths;
}

/** Clear cached taxonomy data so next call reloads from disk (use after CSV update). */
export function clearWayfairCache(): void {
  cachedPaths = null;
  cachedPromptBlock = null;
}

/** Whether a real Wayfair taxonomy has been provided yet (i.e. the CSV has class rows). */
export function hasWayfairTaxonomy(): boolean {
  try {
    return loadWayfairCategoryPaths().length > 0;
  } catch {
    return false;
  }
}

/**
 * Format the Wayfair class list for the Claude categorization prompt.
 * Flat list — Wayfair classes are a single level (code + name), not a tree.
 */
export function formatWayfairTaxonomyForPrompt(): string {
  if (cachedPromptBlock) return cachedPromptBlock;

  const paths = loadWayfairCategoryPaths();
  cachedPromptBlock = paths.map((p) => `- ${p}`).join("\n");
  return cachedPromptBlock;
}
