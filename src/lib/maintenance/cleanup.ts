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
//
// ── Why every delete here is bounded ────────────────────────────────────────
//
// This used to be five unbounded `deleteMany` calls. That is the exact shape of
// the statement that took this database down: DELETE journals the whole 8KB
// page for every row it touches, so clearing 49,136 cached Walmart items wrote
// more WAL than the volume had left, and Postgres could not restart — it ran
// out of space replaying the log it had just written.
//
// A schedule makes that WORSE rather than better if the statement is unbounded,
// because the first run after a long gap is the largest one. So each rule
// deletes in batches, stops at a per-run ceiling, and reports when it hit that
// ceiling; the next run picks up where it left off. A backlog drains over a few
// days instead of in one transaction that cannot be rolled back safely.
//
// What this does NOT do is shrink the database file. DELETE leaves dead tuples
// that autovacuum makes available for re-use, so the table stops GROWING but
// the space is not handed back to the operating system. Returning it needs
// VACUUM FULL (or TRUNCATE), which takes a lock and free space of its own —
// deliberately a manual operation, not something a cron does at 4am.

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
  /**
   * The most rows ONE rule may delete in ONE run.
   *
   * The ceiling that keeps a first run after months of backlog from becoming
   * the single statement that fills the disk. 5,000 rows of the bulkiest table
   * (cached Walmart items average ~12KB) is roughly 60MB touched — large
   * enough to make real progress daily, small enough that the WAL it writes is
   * never the thing that runs the volume out.
   */
  maxDeletesPerRule: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  keepaCodeAuthoritativeDays: 180,
  keepaCodeKeywordDays: 30,
  keepaProductDays: 30,
  walmartAuthoritativeDays: 90,
  walmartNameDays: 14,
  maxDeletesPerRule: 5_000,
};

/** Rows per statement. Small enough that no single delete is a long transaction. */
export const BATCH_ROWS = 1_000;

export interface CleanupResult {
  deleted: Record<string, number>;
  /**
   * Rules that stopped at `maxDeletesPerRule` with rows still expired. Not an
   * error — it is the backlog draining — but the caller should know the run
   * was incomplete rather than assume the caches are now within policy.
   */
  capped: string[];
  ranAt: string;
}

function cutoff(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * One thing to delete: a table, an optional source filter, and an age.
 *
 * Split out from the execution so the policy can be read and tested without a
 * database. `table` is never user input — it comes from the literals below —
 * which is what makes interpolating it into the statement safe; every value is
 * still a bound parameter.
 */
export interface CleanupRule {
  /** Name this rule reports under. */
  key: string;
  table: "KeepaCodeLookup" | "KeepaProductCache" | "WalmartItemCache";
  /** Omitted when the table has no `source` column, or the rule covers all of them. */
  sources?: string[];
  olderThanDays: number;
}

export function cleanupRules(policy: RetentionPolicy): CleanupRule[] {
  return [
    // Keepa barcode→ASIN mappings — split by source so authoritative bindings
    // (the expensive ones to re-derive) survive far longer than keyword guesses.
    {
      key: "keepaCodeLookup_keyword",
      table: "KeepaCodeLookup",
      sources: ["keyword", "sibling"],
      olderThanDays: policy.keepaCodeKeywordDays,
    },
    {
      key: "keepaCodeLookup_authoritative",
      table: "KeepaCodeLookup",
      sources: ["batch", "rescue"],
      olderThanDays: policy.keepaCodeAuthoritativeDays,
    },
    // Keepa product payloads — the bulkiest Keepa rows (full raw JSON).
    {
      key: "keepaProductCache",
      table: "KeepaProductCache",
      olderThanDays: policy.keepaProductDays,
    },
    // Walmart items — name-search hits are fuzzy and expire sooner than the
    // seller/UPC answers.
    {
      key: "walmartItemCache_name",
      table: "WalmartItemCache",
      sources: ["name"],
      olderThanDays: policy.walmartNameDays,
    },
    {
      key: "walmartItemCache_authoritative",
      table: "WalmartItemCache",
      sources: ["seller", "upc"],
      olderThanDays: policy.walmartAuthoritativeDays,
    },
  ];
}

/**
 * Delete at most `limit` matching rows.
 *
 * `ctid IN (SELECT … LIMIT n)` is the way to bound a DELETE in Postgres, which
 * has no DELETE … LIMIT. The inner select walks the `fetchedAt` index, so the
 * cost is proportional to what is being removed rather than to the table.
 */
async function deleteBatch(rule: CleanupRule, before: Date, limit: number): Promise<number> {
  const where = rule.sources
    ? `"source" = ANY($1::text[]) AND "fetchedAt" < $2`
    : `"fetchedAt" < $1`;
  const limitPos = rule.sources ? 3 : 2;
  const params = rule.sources ? [rule.sources, before, limit] : [before, limit];
  return prisma.$executeRawUnsafe(
    `DELETE FROM "${rule.table}" WHERE ctid IN (
       SELECT ctid FROM "${rule.table}" WHERE ${where} LIMIT $${limitPos}
     )`,
    ...params,
  );
}

/**
 * Delete cache rows older than the policy allows, in bounded batches.
 *
 * Returns per-rule delete counts and the rules that stopped at the ceiling.
 * Idempotent and safe to run on any schedule — deleted rows simply get
 * re-fetched on demand, and a run that does not finish leaves the rest for the
 * next one.
 */
export async function cleanupCaches(
  policy: RetentionPolicy = DEFAULT_RETENTION,
): Promise<CleanupResult> {
  const deleted: Record<string, number> = {};
  const capped: string[] = [];

  for (const rule of cleanupRules(policy)) {
    const before = cutoff(rule.olderThanDays);
    const ceiling = Math.max(0, policy.maxDeletesPerRule);
    let total = 0;

    while (total < ceiling) {
      const take = Math.min(BATCH_ROWS, ceiling - total);
      const n = await deleteBatch(rule, before, take);
      total += n;
      // A short batch means the rule ran out of expired rows, so it is done.
      if (n < take) break;
    }
    // Stopped at the ceiling rather than because the rows ran out. A full
    // final batch that happened to take the last expired row reports here too;
    // erring towards "there may be more" costs one extra empty run tomorrow,
    // while the opposite error would quietly declare a backlog cleared.
    if (ceiling > 0 && total >= ceiling) capped.push(rule.key);

    deleted[rule.key] = total;
  }

  return { deleted, capped, ranAt: new Date().toISOString() };
}
