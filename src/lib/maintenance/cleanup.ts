import { prisma } from "@/lib/db";

// Regular data cleanup to keep the database under its storage cap.
//
// Everything here is safe to delete: the cache tables only hold answers we can
// re-fetch from the marketplace APIs, so a purged row just costs one lookup the
// next time it's needed. Retention is keyed off each row's `fetchedAt`, and —
// where the table records it — off `source`, because a fuzzy match (keyword /
// name search) goes stale faster than an authoritative one (batch / seller).
//
// The thresholds below are deliberately conservative defaults; tune them to how
// fast your data churns and how tight the storage cap is.

export interface RetentionPolicy {
  /** Authoritative Keepa barcode→ASIN bindings (source: batch | rescue). Effectively permanent, so kept longest. */
  keepaCodeAuthoritativeDays: number;
  /** Fuzzy Keepa barcode→ASIN bindings (source: keyword). Guesses — expire sooner. */
  keepaCodeKeywordDays: number;
  /** Cached Keepa product payloads. Price ages fastest; identity fields are stable. */
  keepaProductDays: number;
  /** Authoritative Walmart items (source: seller | upc). */
  walmartAuthoritativeDays: number;
  /** Fuzzy Walmart items (source: name search). */
  walmartNameDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  keepaCodeAuthoritativeDays: 180,
  keepaCodeKeywordDays: 30,
  keepaProductDays: 30,
  walmartAuthoritativeDays: 90,
  walmartNameDays: 14,
};

export interface CleanupResult {
  deleted: Record<string, number>;
  ranAt: string;
}

function cutoff(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Delete cache rows older than the policy allows. Returns per-table delete
 * counts. Idempotent and safe to run on any schedule — deleted rows simply
 * get re-fetched on demand.
 */
export async function cleanupCaches(
  policy: RetentionPolicy = DEFAULT_RETENTION,
): Promise<CleanupResult> {
  const deleted: Record<string, number> = {};

  // Keepa barcode→ASIN mappings — split by source so authoritative bindings
  // (the expensive ones to re-derive) survive far longer than keyword guesses.
  deleted.keepaCodeLookup_keyword = (
    await prisma.keepaCodeLookup.deleteMany({
      where: { source: "keyword", fetchedAt: { lt: cutoff(policy.keepaCodeKeywordDays) } },
    })
  ).count;
  deleted.keepaCodeLookup_authoritative = (
    await prisma.keepaCodeLookup.deleteMany({
      where: {
        source: { in: ["batch", "rescue"] },
        fetchedAt: { lt: cutoff(policy.keepaCodeAuthoritativeDays) },
      },
    })
  ).count;

  // Keepa product payloads — the bulkiest Keepa rows (full raw JSON).
  deleted.keepaProductCache = (
    await prisma.keepaProductCache.deleteMany({
      where: { fetchedAt: { lt: cutoff(policy.keepaProductDays) } },
    })
  ).count;

  // Walmart items — name-search hits are fuzzy and expire sooner than the
  // seller/UPC answers.
  deleted.walmartItemCache_name = (
    await prisma.walmartItemCache.deleteMany({
      where: { source: "name", fetchedAt: { lt: cutoff(policy.walmartNameDays) } },
    })
  ).count;
  deleted.walmartItemCache_authoritative = (
    await prisma.walmartItemCache.deleteMany({
      where: {
        source: { in: ["seller", "upc"] },
        fetchedAt: { lt: cutoff(policy.walmartAuthoritativeDays) },
      },
    })
  ).count;

  return { deleted, ranAt: new Date().toISOString() };
}
