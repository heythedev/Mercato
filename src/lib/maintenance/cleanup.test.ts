import { describe, expect, it } from "vitest";
import { BATCH_ROWS, DEFAULT_RETENTION, cleanupRules, type RetentionPolicy } from "./cleanup";

/**
 * The policy, without a database.
 *
 * Two things can go wrong here and neither shows up as an error. A source
 * value no rule covers never expires, so that slice of the cache grows for
 * ever while the cleanup reports success every night. And a ceiling large
 * enough to matter turns the nightly job into the single unbounded DELETE that
 * took this database down once already.
 */

/**
 * Every `source` the writers actually store.
 *
 * Kept here deliberately rather than imported: this list is the CLAIM, and a
 * new source added to a writer has to be added here too, which is the moment
 * somebody notices it has no retention rule.
 */
const WRITTEN_SOURCES = {
  KeepaCodeLookup: ["batch", "rescue", "keyword", "sibling"],
  WalmartItemCache: ["seller", "upc", "name"],
} as const;

describe("retention rules", () => {
  it("covers every source exactly once — nothing immortal, nothing fought over", () => {
    for (const [table, sources] of Object.entries(WRITTEN_SOURCES)) {
      for (const source of sources) {
        const matching = cleanupRules(DEFAULT_RETENTION).filter(
          (r) => r.table === table && r.sources?.includes(source),
        );
        expect(matching.map((r) => r.key), `${table}.source=${source}`).toHaveLength(1);
      }
    }
  });

  it("sweeps the source-less table without a source filter", () => {
    // KeepaProductCache has no `source` column; a rule that filtered on one
    // would match nothing and the bulkiest Keepa rows would never expire.
    const rule = cleanupRules(DEFAULT_RETENTION).find((r) => r.table === "KeepaProductCache");
    expect(rule).toBeDefined();
    expect(rule!.sources).toBeUndefined();
  });

  it("expires a guess sooner than an authoritative answer", () => {
    // The whole reason the rules split by source. A keyword match is a guess
    // and a stale one picks the wrong product; a barcode binding is a fact.
    const by = Object.fromEntries(cleanupRules(DEFAULT_RETENTION).map((r) => [r.key, r.olderThanDays]));
    expect(by.keepaCodeLookup_keyword).toBeLessThan(by.keepaCodeLookup_authoritative);
    expect(by.walmartItemCache_name).toBeLessThan(by.walmartItemCache_authoritative);
  });

  it("reads its ages from the policy, so a cron can tune them without a deploy", () => {
    const tight: RetentionPolicy = { ...DEFAULT_RETENTION, keepaProductDays: 3 };
    const rule = cleanupRules(tight).find((r) => r.key === "keepaProductCache");
    expect(rule!.olderThanDays).toBe(3);
  });
});

describe("the ceiling that keeps a scheduled delete survivable", () => {
  it("bounds one run, and one statement inside it", () => {
    // Not taste. An unbounded DELETE across 49,136 cached Walmart items wrote
    // more WAL than the volume had free and the database could not restart.
    // A schedule makes an unbounded delete worse, not better, because the
    // first run after a gap is the biggest one.
    expect(DEFAULT_RETENTION.maxDeletesPerRule).toBeGreaterThan(0);
    expect(DEFAULT_RETENTION.maxDeletesPerRule).toBeLessThanOrEqual(10_000);
    expect(BATCH_ROWS).toBeLessThanOrEqual(DEFAULT_RETENTION.maxDeletesPerRule);
  });

  it("a whole run cannot approach the delete that broke it", () => {
    const worstCase = cleanupRules(DEFAULT_RETENTION).length * DEFAULT_RETENTION.maxDeletesPerRule;
    expect(worstCase).toBeLessThan(49_136);
  });
});
