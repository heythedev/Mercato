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
  { id: "wayfair", label: "Wayfair", domain: "wayfair.com" },
  { id: "ebay", label: "eBay", domain: "ebay.com" },
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
 * Every marketplace id that can appear on a stored row, Amazon's US variant
 * included.
 *
 * MARKETPLACE_IDS is the grantable TILES; this is what a project or a
 * template is actually tagged with, which is not the same list — Amazon
 * expands into two at create time.
 *
 * It exists because three screens each kept their own copy of this list and
 * they disagreed. The admin Templates dropdown had seven entries hardcoded
 * and was missing Wayfair from the day Wayfair shipped, so no Wayfair
 * template could be uploaded through it; eBay was missing for the same
 * reason the day after it was added. Nothing errored in either case — the
 * marketplace simply was not offered, which looks like a deployment problem
 * and is not one.
 */
export const MARKETPLACE_IDS_WITH_VARIANTS: readonly string[] = [
  "amazon_us",
  ...MARKETPLACE_TILES.map((m) => m.id),
];

/** Amazon's stored variant needs a name of its own; every other id takes the
 *  tile's label. */
const VARIANT_LABELS: Record<string, string> = { amazon_us: "Amazon US" };

/** The display name for a stored marketplace id. Falls back to the id itself
 *  rather than rendering an empty cell for a marketplace nobody has named. */
export function marketplaceLabel(marketplace: string): string {
  const id = String(marketplace ?? "").trim().toLowerCase();
  if (VARIANT_LABELS[id]) return VARIANT_LABELS[id]!;
  return MARKETPLACE_TILES.find((m) => m.id === toTileId(id))?.label ?? marketplace;
}

/** The domain a stored marketplace id belongs to — what the favicon logos are
 *  drawn from — or undefined when it has none. */
export function marketplaceDomain(marketplace: string): string | undefined {
  const id = String(marketplace ?? "").trim().toLowerCase();
  return MARKETPLACE_TILES.find((m) => m.id === toTileId(id))?.domain;
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
