/**
 * Single source of truth for the marketplaces users can create projects for.
 *
 * `id` is the top-level tile id an admin grants and the new-project form
 * offers. Amazon expands into US/International project marketplaces at create
 * time, but access is granted per top-level tile — see `AMAZON_VARIANTS`.
 */
export type MarketplaceTile = {
  id: string;
  label: string;
  domain: string;
};

export const MARKETPLACE_TILES: readonly MarketplaceTile[] = [
  { id: "amazon", label: "Amazon", domain: "amazon.com" },
  { id: "walmart", label: "Walmart", domain: "walmart.com" },
  { id: "bestbuy", label: "Best Buy", domain: "bestbuy.com" },
  { id: "temu", label: "Temu", domain: "temu.com" },
  { id: "mathis", label: "Mathis", domain: "mathishome.com" },
  { id: "sears", label: "Sears", domain: "sears.com" },
  // { id: "wayfair", label: "Wayfair", domain: "wayfair.com" },
] as const;

/** All grantable top-level marketplace ids. */
export const MARKETPLACE_IDS = MARKETPLACE_TILES.map((m) => m.id);

/** Amazon's stored project marketplaces both map back to the "amazon" tile. */
export const AMAZON_VARIANTS = ["amazon", "amazon_us"];

/**
 * Map a stored project marketplace (e.g. "amazon_us") back to the top-level
 * tile id used for access control (e.g. "amazon").
 */
export function toTileId(marketplace: string): string {
  return marketplace === "amazon_us" ? "amazon" : marketplace;
}

/**
 * Whether a user may create a project for the given (stored) marketplace.
 * Admins are unrestricted; everyone else needs the tile in their allow-list.
 */
export function canUseMarketplace(
  marketplace: string,
  opts: { role: string; allowedMarketplaces: string[] },
): boolean {
  if (opts.role === "admin") return true;
  return opts.allowedMarketplaces.includes(toTileId(marketplace));
}
