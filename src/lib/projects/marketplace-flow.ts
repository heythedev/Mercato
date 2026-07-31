// Which marketplaces skip the Verify step. These have no public listing API to
// check catalog data against, so a project goes Upload → Categorize directly.
// Keep this in sync with the client-side SKIP_VERIFY set in project-detail.tsx.
export const SKIP_VERIFY_MARKETPLACES = new Set(["temu", "bestbuy", "mathis", "sears", "wayfair"]);

/** True when this marketplace has no Verify step (Upload → Categorize directly). */
export function skipsVerification(marketplace: string): boolean {
  return SKIP_VERIFY_MARKETPLACES.has(marketplace.toLowerCase());
}

/**
 * The stable status a categorization run should fall back to on failure — i.e.
 * the step *before* Categorize. For marketplaces with a Verify step that is
 * "verified"; for skip-verify marketplaces (Temu, Best Buy, …) there is no
 * verified state, so it's "uploaded". Using "verified" for those would wrongly
 * show a green "Verified" badge on a project that never verifies.
 */
export function preCategorizeStatus(marketplace: string): "uploaded" | "verified" {
  return skipsVerification(marketplace) ? "uploaded" : "verified";
}
