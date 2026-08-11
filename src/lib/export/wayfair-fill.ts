import type { Product } from "@prisma/client";
import { toDisplayBarcode } from "../barcode";

/**
 * Wayfair template-fill scaffold (Option B — dedicated filler).
 *
 * ⚠️ STATUS: SCAFFOLD, NOT YET WIRED INTO THE EXPORT DISPATCH.
 * The real Wayfair "Product Addition Template" workbook and the per-class Attributes
 * schemas are not yet available, so `fillWayfairTemplate` throws until they are. This
 * file exists to (a) capture the design so the export path can be finished quickly
 * once the real files land, and (b) hold the pricing resolver, which is used now.
 *
 * WHY A DEDICATED FILLER (not the shared fillTemplateXlsx):
 * The shared engine assumes ONE header row (found by "most populated row"), with data
 * written at headerRow+1. The Wayfair class sheet has SEVEN stacked header rows:
 *   Row 1: internal field key      e.g. core::supplierPartNumber   ← the STABLE contract
 *   Row 2: section header          e.g. "Basic Information"
 *   Row 3: data-priority tag       Required / Recommended / Additional / Conditional
 *   Row 4: human-readable header   what an importer sees
 *   Row 5: help text / validation rule
 *   Row 6: data type               Text / Select / Number / Whole Number / Yes or No
 *   Row 7: default-answer row (optional; auto-applies to the class)
 *   Row 8+: actual product data
 * Feeding this to the shared engine would write product rows into the header block.
 *
 * We map off ROW 1 (the machine-readable `core::*` / section field keys), which is a
 * stable contract across classes — unlike the human headers. Sections 1–7 and 9 are
 * structurally identical across every class; only Section 8 (Attributes) varies.
 *
 * Sheets that must be preserved untouched when re-saving into the workbook:
 *   WAYFAIR_USE_ONLY (hidden metadata), *-WUO_ERR / *-WUO_TRK (validation engine),
 *   Valid Values (dropdown lists), and column A formulas on the data sheet.
 */

// ── Pricing ────────────────────────────────────────────────────────────────────
// Requirement: submitted price = cost + 25% margin (cost × 1.25), mapped to the
// template's Pricing → Base Cost field.
//
// ⚠️ OPEN QUESTION (do NOT resolve by assumption): the client must confirm whether
// the 25% margin already nets out Wayfair's own commission or is independent of it.
// Wayfair adds commission on top at their end. If the 25% must ABSORB commission,
// this multiplier changes. Until confirmed, WAYFAIR_MARGIN is the plain 25% and this
// caveat is surfaced, not silently baked in.
export const WAYFAIR_MARGIN = 0.25;

export interface WayfairPrice {
  /** cost × (1 + margin), rounded to cents; null when cost is unavailable. */
  price: number | null;
  /** The cost the price was derived from; null when not found in the data. */
  cost: number | null;
  /** True when cost was missing → the SKU should be flagged, not priced by guess. */
  costMissing: boolean;
}

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findCost(p: Product): number | null {
  const vd = p.vendorData as Record<string, unknown> | null;
  if (!vd) return null;
  const norm = new Map<string, unknown>();
  for (const [k, v] of Object.entries(vd)) {
    if (v !== "" && v != null) norm.set(normKey(k), v);
  }
  // Same cost aliases the shared field resolver uses for `cost` (zip.ts).
  const aliases = ["cost", "cost_price", "wholesale_price", "vendor_price", "net_price", "base_cost", "basecost"];
  for (const a of aliases) {
    const raw = norm.get(normKey(a));
    if (raw == null) continue;
    const n = typeof raw === "number" ? raw : parseFloat(String(raw).replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * Resolve the Wayfair submitted price for a product: cost × 1.25.
 * Returns costMissing=true (and price=null) when no cost is found — the caller must
 * flag the SKU for manual review rather than shipping a guessed price.
 */
export function resolveWayfairPrice(p: Product, margin = WAYFAIR_MARGIN): WayfairPrice {
  const cost = findCost(p);
  if (cost == null) return { price: null, cost: null, costMissing: true };
  const price = Math.round(cost * (1 + margin) * 100) / 100;
  return { price, cost, costMissing: false };
}

// ── Field-key mapping (Sections 1–7, 9) ──────────────────────────────────────────
// Maps stable Wayfair row-1 field keys → a resolver over our Product/vendorData.
// Section 8 (Attributes) is class-specific and intentionally excluded here; it needs
// a per-class attribute schema (see fillWayfairTemplate's throw).
//
// This table is a STARTING POINT built from the sample template's documented sections;
// it must be reconciled against the real workbook's actual row-1 keys before use.
export const WAYFAIR_CORE_FIELD_KEYS: Record<string, (p: Product) => string> = {
  "core::supplierPartNumber": (p) => p.vendorSku ?? "",
  "core::brand": (p) => p.brand ?? "",
  // Re-normalized so an 11-digit UPC (leading zero stripped by Excel) goes out
  // left-padded to the 12 digits marketplaces require.
  "core::upc": (p) => (p.upc ? toDisplayBarcode(p.upc) ?? p.upc : ""),
  "core::productName": (p) => p.name ?? "",
  // Pricing → Base Cost carries the wholesale cost. Whether the *submitted* price
  // (cost × 1.25) belongs in Base Cost or a separate price field depends on the real
  // template's Pricing section — reconcile before enabling.
  "core::baseCost": (p) => {
    const { price } = resolveWayfairPrice(p);
    return price == null ? "" : String(price);
  },
};

export interface WayfairFillInput {
  products: Product[];
  /** The Wayfair class this file is for, e.g. "6115 - Luggage Racks". */
  wayfairClass: string;
  /** Raw bytes of the real Wayfair class template workbook. */
  templateFileData: Buffer;
}

/**
 * Fill a Wayfair class template with product rows.
 *
 * NOT YET IMPLEMENTED — throws until the real Wayfair template workbook and the
 * per-class Attributes schema are provided. When implemented it must:
 *   1. Load the workbook, locate the class data sheet by name (matches `wayfairClass`).
 *   2. Read row 1 field keys; map WAYFAIR_CORE_FIELD_KEYS + the per-class attribute
 *      schema onto the columns.
 *   3. Resolve Select-type columns against the `Valid Values` sheet (strict match).
 *   4. Write product rows from row 8, preserving rows 1–7 and column A formulas.
 *   5. Leave WAYFAIR_USE_ONLY / *_ERR / *_TRK / Valid Values sheets untouched.
 */
export function fillWayfairTemplate(_input: WayfairFillInput): Promise<Buffer> {
  throw new Error(
    "Wayfair template fill is not enabled yet: the real Wayfair class template " +
    "workbook and per-class Attributes schema are required. See wayfair-fill.ts.",
  );
}
