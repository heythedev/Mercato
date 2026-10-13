import { prisma } from "@/lib/db";
import { profileFor } from "@/lib/marketplaces/profile";
import { normalizeKey } from "./zip";

/**
 * Changes to a cell that a person stated once and the exporter applies for
 * ever after.
 *
 * MarketplaceInstruction is guidance a model has to interpret per product.
 * This is the other kind, and most of what people actually ask for:
 *
 *   "That word must never appear."
 *   "That column must ship empty."
 *   "That sentence goes on the end of every description."
 *
 * None of those is a judgement. Routing them through a model costs a call,
 * and worse, makes them conditional on the model having read the instruction
 * properly — a rule that holds 97% of the time is not a rule. So they are
 * applied where the cell is written, to every row, deterministically.
 *
 * ExportDefault already covers "this column always holds this value", which is
 * why there is no `constant` action: a default is written INTO an empty cell,
 * these transform whatever is there.
 */

export type ColumnRuleAction = "blank" | "replace" | "append";

export type ColumnRule = {
  id: string;
  marketplace: string;
  teamId: string | null;
  /** normalizeKey of the column label, or "*" for every text column. */
  column: string;
  action: ColumnRuleAction;
  find: string | null;
  value: string | null;
  note: string | null;
  enabled: boolean;
};

/** Every rule in force, indexed for the hot path. A plain array is fine: an
 *  account has a handful of these, not thousands. */
export type ColumnRuleSet = {
  rules: ColumnRule[];
  /** True when there is nothing to do, so the caller can skip the work
   *  entirely — this runs once per cell on a 5,000-row file. */
  empty: boolean;
};

export const EMPTY_RULES: ColumnRuleSet = { rules: [], empty: true };

/** Columns a rule may never touch, whatever an admin writes.
 *
 *  A find-and-replace loose on an identifier is not a formatting preference;
 *  it is a different product. A barcode with a word removed from it still
 *  looks like a barcode in the file and matches somebody else's listing in
 *  the marketplace's catalogue. */
const PROTECTED = new Set(
  ["upc", "ean", "isbn", "gtin", "asin", "sku", "vendorsku", "shopsku", "barcode", "mpn"].map(normalizeKey),
);

export function isProtectedColumn(column: string): boolean {
  return PROTECTED.has(normalizeKey(column));
}

/**
 * The rules in force for a marketplace. A team's rules are added to the
 * global ones rather than replacing them: a global rule usually says
 * something must never ship, and a team should not be able to switch that off
 * by writing a rule of their own.
 */
export async function loadColumnRules(
  marketplace: string,
  teamId: string | null,
): Promise<ColumnRuleSet> {
  const id = profileFor(marketplace).id;
  try {
    const rows = await prisma.marketplaceColumnRule.findMany({
      where: {
        marketplace: id,
        enabled: true,
        OR: [{ teamId: null }, ...(teamId ? [{ teamId }] : [])],
      },
      orderBy: { createdAt: "asc" },
    });
    const rules = rows
      .filter((r) => !isProtectedColumn(r.column))
      .map((r) => ({
        id: r.id,
        marketplace: r.marketplace,
        teamId: r.teamId,
        column: normalizeKey(r.column) || "*",
        action: r.action as ColumnRuleAction,
        find: r.find,
        value: r.value,
        note: r.note,
        enabled: r.enabled,
      }));
    return { rules, empty: rules.length === 0 };
  } catch (e) {
    // A missing table or an unreachable database must not stop an export.
    console.warn(`[column-rules] could not load for ${id}:`, (e as Error).message);
    return EMPTY_RULES;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * One cell, with every rule that names it applied in order.
 *
 * Pure, so the whole behaviour is checkable without a database — which is the
 * only way to be sure about something that runs on every cell of every file.
 *
 * Order is the order they were written. Two rules touching one column compose
 * rather than compete, and an admin reading the list top to bottom sees what
 * the cell goes through.
 */
export function applyColumnRules(
  set: ColumnRuleSet,
  columnLabel: string,
  value: string,
): string {
  if (set.empty) return value;
  const column = normalizeKey(columnLabel);
  // Identifiers are never transformed, even if a rule somehow names one.
  if (isProtectedColumn(column)) return value;

  let out = String(value ?? "");
  for (const rule of set.rules) {
    if (rule.column !== "*" && rule.column !== column) continue;
    // A wildcard rule is for text, not for a cell that happens to be a number.
    if (rule.column === "*" && !/[a-z]/i.test(out)) continue;

    if (rule.action === "blank") {
      out = "";
      continue;
    }
    if (rule.action === "append") {
      const add = (rule.value ?? "").trim();
      // Appending to an empty cell would make an empty column look answered.
      if (!add || !out.trim()) continue;
      if (out.includes(add)) continue; // already there; a re-export must not stack it
      out = `${out}${out.endsWith(" ") ? "" : " "}${add}`;
      continue;
    }
    if (rule.action === "replace") {
      const find = (rule.find ?? "").trim();
      if (!find || !out) continue;
      // Whole word, like the restricted-keyword matcher: without the
      // boundary "gap" matches "gaps" and a rule nobody can predict is a rule
      // somebody switches off.
      const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(find)}([^A-Za-z0-9]|$)`, "gi");
      const replacement = (rule.value ?? "").trim();
      out = out.replace(re, (_m, before: string, after: string) =>
        replacement ? `${before}${replacement}${after}` : `${before}${after}`,
      );
      out = out.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1");
    }
  }
  return out.trim() === "" ? "" : out;
}
