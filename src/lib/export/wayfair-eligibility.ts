import type { Product } from "@prisma/client";

/**
 * Wayfair-specific pre-export eligibility checks.
 *
 * Wayfair is stricter than the other marketplaces about WHAT may be listed, so
 * before a product reaches the template-fill stage it runs three checks derived
 * from the client requirements. Per the requirements, none of these silently
 * mutate a product: a product is either kept, EXCLUDED (with a reason), or KEPT
 * but FLAGGED for manual review. The caller is responsible for surfacing the
 * exclusions/flags (e.g. a companion review CSV in the export ZIP) — this module
 * only classifies.
 *
 * Three checks:
 *   1. Category eligibility  — Wayfair only accepts home-adjacent classes.
 *   2. Shipping eligibility  — vendor-managed carriers (e.g. Winsome) may be ineligible.
 *   3. Brand-content risk    — reused cross-brand content is a complaint risk.
 *
 * ⚠️ Several thresholds/lists below are intentionally NOT hardcoded to guessed
 * values — they are flagged as OPEN and default to the safe/no-op behaviour so we
 * never silently exclude or force-list a SKU on an assumption. See each check.
 */

export type WayfairDecision = "keep" | "exclude" | "flag";

export interface WayfairEligibility {
  productId: string;
  decision: WayfairDecision;
  /** Machine-readable reason codes (may be several, e.g. flagged AND excluded-adjacent). */
  reasons: string[];
  /** Human-readable explanation for the review CSV. */
  detail: string;
}

/** Normalize a vendorData key the same way the export field resolver does. */
function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildVdNorm(vd: Record<string, unknown> | null): Map<string, unknown> {
  const m = new Map<string, unknown>();
  if (!vd) return m;
  for (const [k, v] of Object.entries(vd)) {
    if (v !== "" && v != null) m.set(normKey(k), v);
  }
  return m;
}

function vdLookup(vdNorm: Map<string, unknown>, ...aliases: string[]): string | undefined {
  for (const a of aliases) {
    const v = vdNorm.get(normKey(a));
    if (v !== undefined && v !== null && String(v).trim() !== "") return String(v).trim();
  }
  return undefined;
}

/**
 * ── Check 1: Category eligibility ────────────────────────────────────────────
 * Wayfair only accepts home-adjacent classes (furniture, décor, kitchen, lighting,
 * outdoor, storage, home improvement). A SKU outside these should be EXCLUDED from
 * the Wayfair export — not force-categorized.
 *
 * ⚠️ OPEN (blocked on real taxonomy): the authoritative list of eligible Wayfair
 * classes must come from wayfair_categories.csv (Wayfair's real taxonomy). Until a
 * curated allow-set exists, this returns "keep" for everything EXCEPT products that
 * failed categorization ("Uncategorized" / empty) — those are flagged, not dropped,
 * so a human decides. Do NOT invent a keyword allow-list here; every class in the
 * taxonomy sheet is by definition Wayfair-eligible once the sheet is populated from
 * Wayfair's real spec.
 */
function checkCategory(p: Product): { decision: WayfairDecision; reason?: string; detail?: string } {
  const cat = (p.marketplaceCategory || p.categoryPath || "").trim();
  if (!cat || /^uncategorized$/i.test(cat)) {
    return {
      decision: "flag",
      reason: "category_unresolved",
      detail: "Product has no Wayfair class assigned (Uncategorized) — review before listing.",
    };
  }
  // Once wayfair_categories.csv is populated, any assigned class is Wayfair-eligible
  // by construction (the taxonomy only contains accepted classes). No keyword filter.
  return { decision: "keep" };
}

/**
 * ── Check 2: Shipping eligibility ────────────────────────────────────────────
 * Wayfair prefers its own shipping service, not vendor-specific carriers. SKUs that
 * depend on vendor-managed carriers (Winsome is the one named in the requirements)
 * may not be eligible. We FLAG these for review rather than silently passing or
 * dropping them.
 *
 * ⚠️ OPEN: (a) the exact vendorData column carrying carrier info varies per vendor
 * sheet — confirm against "For listing on Wayfair.xlsx". (b) whether Winsome is the
 * only ineligible carrier or one of a list. Default: flag known vendor-managed
 * carriers; keep (don't exclude) so the client makes the call.
 */
const VENDOR_MANAGED_CARRIERS = [
  "winsome",
  // Add other vendor-managed carriers here once confirmed with the client.
];

function checkShipping(vdNorm: Map<string, unknown>): { decision: WayfairDecision; reason?: string; detail?: string } {
  const carrier = vdLookup(
    vdNorm,
    "carrier", "ship_via", "shipvia", "shipping_carrier", "shippingcarrier",
    "shipping_method", "shippingmethod", "fulfillment", "shipped_by", "shippedby",
    "vendor_carrier", "freight_carrier",
  );
  if (!carrier) return { decision: "keep" };
  const c = carrier.toLowerCase();
  const hit = VENDOR_MANAGED_CARRIERS.find((vm) => c.includes(vm));
  if (hit) {
    return {
      decision: "flag",
      reason: "vendor_managed_carrier",
      detail: `Ships via vendor-managed carrier "${carrier}" — may be ineligible for Wayfair's own shipping. Confirm before listing.`,
    };
  }
  return { decision: "keep" };
}

/**
 * ── Check 3: Brand-content risk ──────────────────────────────────────────────
 * Some PL SKUs reuse images/bullet copy sourced from a DIFFERENT brand's main ASIN
 * (e.g. listing under "Casafoyer" using content from another brand's ASIN). This is
 * a brand-complaint risk and must surface as a manual-review FLAG per SKU — never
 * auto-resolved.
 *
 * ⚠️ OPEN: how "content source brand" is represented in the vendor sheet is TBD.
 * Heuristic used here: if vendorData carries a content-source / original-brand hint
 * that differs from the listing brand, flag it. If no such hint exists, we cannot
 * detect the risk from data alone — so this check is a no-op rather than a guess.
 * Do NOT infer brand mismatch from title text; that produces false positives.
 */
const OWNED_BRANDS = ["casafoyer", "ergode", "yardlio"];

function checkBrandRisk(p: Product, vdNorm: Map<string, unknown>): { decision: WayfairDecision; reason?: string; detail?: string } {
  const listingBrand = (p.brand || "").trim().toLowerCase();
  const sourceBrand = vdLookup(
    vdNorm,
    "content_source_brand", "contentsourcebrand", "source_brand", "sourcebrand",
    "original_brand", "originalbrand", "content_brand", "asin_brand", "listing_source_brand",
  );
  if (!sourceBrand) {
    // No explicit content-source signal in the data — cannot detect from data alone.
    return { decision: "keep" };
  }
  if (listingBrand && normKey(sourceBrand) !== normKey(listingBrand)) {
    return {
      decision: "flag",
      reason: "cross_brand_content",
      detail: `Listing brand "${p.brand}" reuses content sourced from "${sourceBrand}" — brand-complaint risk. Manual review required.`,
    };
  }
  // Extra safety: owned-brand listing whose source brand is not an owned brand.
  if (OWNED_BRANDS.includes(normKey(listingBrand)) && !OWNED_BRANDS.includes(normKey(sourceBrand))) {
    return {
      decision: "flag",
      reason: "cross_brand_content",
      detail: `Owned brand "${p.brand}" reuses content from non-owned brand "${sourceBrand}" — manual review required.`,
    };
  }
  return { decision: "keep" };
}

/** Classify one product. `exclude` wins over `flag` wins over `keep`. */
export function classifyWayfairProduct(p: Product): WayfairEligibility {
  const vdNorm = buildVdNorm(p.vendorData as Record<string, unknown> | null);
  const checks = [checkCategory(p), checkShipping(vdNorm), checkBrandRisk(p, vdNorm)];

  const reasons: string[] = [];
  const details: string[] = [];
  let decision: WayfairDecision = "keep";
  for (const c of checks) {
    if (c.reason) reasons.push(c.reason);
    if (c.detail) details.push(c.detail);
    if (c.decision === "exclude") decision = "exclude";
    else if (c.decision === "flag" && decision !== "exclude") decision = "flag";
  }

  return { productId: p.id, decision, reasons, detail: details.join(" ") };
}

/**
 * Split a product list into the products that should be written to the Wayfair
 * export and the review report (excluded + flagged). Kept products include flagged
 * ones — flags are advisory (surfaced in the report), exclusions are removed.
 */
export function applyWayfairEligibility(products: Product[]): {
  eligible: Product[];
  report: WayfairEligibility[];
} {
  const report: WayfairEligibility[] = [];
  const eligible: Product[] = [];
  for (const p of products) {
    const r = classifyWayfairProduct(p);
    if (r.decision !== "keep") report.push(r);
    if (r.decision !== "exclude") eligible.push(p);
  }
  return { eligible, report };
}
