import { prisma } from "@/lib/db";

/**
 * Admin-set values for required columns no data source can answer.
 *
 * Compliance declarations (Prop 65 warning type, the PFAS statement) are the
 * motivating case: they are the same on every row, they are legal statements
 * the seller makes rather than facts about the product, and they were 64 of the
 * 462 empty required cells measured on the live Best Buy project. A model must
 * not invent them and the vendor file never carries them, so they are entered
 * once by an admin and applied deterministically — no AI call, no per-row cost.
 *
 * Keyed on the NORMALIZED column key so one entry answers a column whether the
 * template names it by label ("California Proposition 65 Warning: Type") or by
 * Mirakl attribute code ("californiaProposition65Warning.type").
 */

/** Same normalisation the export's column matching uses. */
export function defaultKey(s: string): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Reserved keys: settings rather than column values.
 *
 * They live in the same table so turning one on needs no migration and no
 * second admin screen, and the UI hides them from the list of column defaults.
 */
export const SETTING_KEYS = {
  /**
   * Keep values in cells the template marks NOT APPLICABLE (grey), instead of
   * blanking them.
   *
   * Off by default, and deliberately so: grey means the marketplace says the
   * attribute does not apply to that category, and a value there can have the
   * row rejected on import. It exists because a client may want the data
   * present anyway — a reviewer reading the sheet, or a marketplace that
   * tolerates extra columns. Only values we actually resolved are kept; nothing
   * is asked of the AI for a column the category says is irrelevant.
   */
  fillNaCells: defaultKey("__fill_na_cells"),
} as const;

/** Whether a reserved boolean setting is switched on for this marketplace. */
export function settingEnabled(defaults: ExportDefaults, key: string): boolean {
  const v = (defaults.get(key) ?? "").trim().toLowerCase();
  return v === "on" || v === "true" || v === "yes" || v === "1";
}

/** True for a key that is a setting, not a column default. */
export function isSettingKey(attribute: string): boolean {
  return (Object.values(SETTING_KEYS) as string[]).includes(attribute);
}

export type ExportDefaults = Map<string, string>;

/**
 * Defaults for one marketplace, as a lookup map.
 *
 * Every alias an attribute might be matched under is indexed: the stored key
 * itself, and — for a dotted Mirakl code — its last segment, so
 * "californiaProposition65Warning.type" also answers a column whose code is
 * category-prefixed ("Wall_Art.californiaProposition65Warning.type").
 */
export async function loadExportDefaults(
  marketplace: string,
  teamId?: string | null,
): Promise<ExportDefaults> {
  const rows = await prisma.exportDefault.findMany({
    where: {
      marketplace: marketplace.toLowerCase(),
      // Global rows apply to everyone; a team's own row applies to that team.
      OR: teamId ? [{ teamId: null }, { teamId }] : [{ teamId: null }],
    },
    select: { attribute: true, value: true, teamId: true },
    // Global first, so a team's row overwrites it in the map below. A
    // compliance declaration one client makes must not leak into another's
    // export, and must beat the house default where they disagree.
    orderBy: { teamId: "asc" },
  });
  const map: ExportDefaults = new Map();
  for (const r of rows) {
    const v = r.value.trim();
    if (!v) continue;
    map.set(r.attribute, v);
  }
  return map;
}

/**
 * The default for a column, or "" when none is set.
 *
 * Callers pass every name the column is known by (stored key, attribute code,
 * header label); the first that matches wins. A dotted code is also tried by
 * its trailing segments, so one entry covers the same attribute across the
 * 1,450 category-prefixed spellings Best Buy issues.
 */
export function defaultFor(defaults: ExportDefaults, ...names: string[]): string {
  if (!defaults.size) return "";
  for (const raw of names) {
    // A settings row must never be mistaken for a column value.
    if (isSettingKey(defaultKey(String(raw ?? "")))) continue;
    const s = String(raw ?? "").trim();
    if (!s) continue;
    const direct = defaults.get(defaultKey(s));
    if (direct) return direct;
    // "Wall_Art.californiaProposition65Warning.type" → try
    // "californiaProposition65Warning.type", then "type".
    const parts = s.split(".");
    for (let i = 1; i < parts.length; i++) {
      const hit = defaults.get(defaultKey(parts.slice(i).join(".")));
      if (hit) return hit;
    }
  }
  return "";
}
