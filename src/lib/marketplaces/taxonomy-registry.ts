import { formatTemuTaxonomyForPrompt, loadTemuCategoryPaths } from "@/lib/ai/temu-taxonomy";
import { formatMathisTaxonomyForPrompt, loadMathisCategoryPaths } from "@/lib/ai/mathis-taxonomy";
import { formatWalmartTaxonomyForPrompt, loadWalmartCategoryPaths } from "@/lib/ai/walmart-taxonomy";
import { formatBestBuyTaxonomyForPrompt, loadBestBuyCategoryPaths } from "@/lib/ai/bestbuy-taxonomy";
import { formatSearsTaxonomyForPrompt, loadSearsCategoryPaths } from "@/lib/ai/sears-taxonomy";
import {
  formatWayfairTaxonomyForPrompt,
  loadWayfairCategoryPaths,
  hasWayfairTaxonomy,
} from "@/lib/ai/wayfair-taxonomy";
import {
  formatEbayTaxonomyForPrompt,
  hasEbayTaxonomy,
  loadEbayCategoryPaths,
} from "@/lib/ai/ebay-taxonomy";
import { profileFor } from "./profile";

/**
 * Where each marketplace's category list comes from.
 *
 * The categoriser used to answer this with six near-identical `if` blocks —
 * one per marketplace, each loading its own CSV — plus a seventh expression
 * listing the same six names again to decide whether the run is constrained,
 * and an eighth picking a batch size. Adding a marketplace meant finding all
 * of them, and missing one left a marketplace that loaded a taxonomy but was
 * not treated as constrained: the model free-forms categories that do not
 * exist, which is the single worst thing this pipeline can do.
 *
 * Kept apart from profile.ts deliberately. That file is data with no imports,
 * so anything may read it; this one pulls in every taxonomy loader, and only
 * the categoriser should carry that weight.
 */

export type TaxonomySource = {
  /** Every leaf path the model may choose from. */
  load: () => string[];
  /** The same list rendered for the prompt. */
  format: () => string;
  /**
   * Why this marketplace cannot be categorised yet, or null when it can.
   *
   * Wayfair ships an EMPTY category CSV on purpose. Free-forming categories
   * there would invent ones Wayfair does not have — the exact reason that
   * integration was reverted once already — so it fails loudly instead.
   */
  unavailableReason?: () => string | null;
  /**
   * Products per AI request. Benchmarked per marketplace: Best Buy's taxonomy
   * is 1,450 leaves and needs a smaller batch to leave room for it.
   */
  batchSize?: number;
};

const SOURCES: Record<string, TaxonomySource> = {
  temu: { load: loadTemuCategoryPaths, format: formatTemuTaxonomyForPrompt, batchSize: 40 },
  bestbuy: { load: loadBestBuyCategoryPaths, format: formatBestBuyTaxonomyForPrompt, batchSize: 20 },
  sears: { load: loadSearsCategoryPaths, format: formatSearsTaxonomyForPrompt },
  mathis: { load: loadMathisCategoryPaths, format: formatMathisTaxonomyForPrompt, batchSize: 40 },
  walmart: { load: loadWalmartCategoryPaths, format: formatWalmartTaxonomyForPrompt, batchSize: 40 },
  ebay: {
    load: loadEbayCategoryPaths,
    format: formatEbayTaxonomyForPrompt,
    // Declared BEFORE the CSV arrives, and refusing until it does. Leaving
    // eBay out of this map would have been worse than wrong: taxonomyFor
    // returns null for an unknown marketplace, isConstrainedMarketplace goes
    // false, and the model free-forms categories eBay does not have.
    unavailableReason: () =>
      hasEbayTaxonomy()
        ? null
        : "eBay categorization is not configured yet: src/lib/ai/data/ebay_categories.csv "
          + "has not been supplied. Add eBay's category export before categorizing eBay projects.",
  },
  wayfair: {
    load: loadWayfairCategoryPaths,
    format: formatWayfairTaxonomyForPrompt,
    unavailableReason: () =>
      hasWayfairTaxonomy()
        ? null
        : "Wayfair categorization is not configured yet: wayfair_categories.csv has no "
          + "class rows. Add Wayfair's real class taxonomy before categorizing Wayfair projects.",
  },
};

/**
 * The taxonomy for a marketplace, or null when it has none.
 *
 * Null is the honest answer for a marketplace nobody has supplied a category
 * list for — including one added tomorrow. The caller then runs unconstrained,
 * which is what Amazon already does, rather than being handed an empty list
 * and told to pick from it.
 */
export function taxonomyFor(marketplace: string): TaxonomySource | null {
  return SOURCES[profileFor(marketplace).id] ?? null;
}

/** Whether this marketplace's model must pick from a fixed list. */
export function isConstrainedMarketplace(marketplace: string): boolean {
  return taxonomyFor(marketplace) !== null;
}
