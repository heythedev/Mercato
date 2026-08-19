/**
 * Persistent Keepa cache (Amazon only).
 *
 * Keepa bills per product token, so the cheapest request is the one we never
 * make. Two caches with different lifetimes:
 *
 *  • code → ASIN  — a barcode's product identity is effectively permanent.
 *    This is the expensive half to miss: an unresolved code costs a rescue
 *    call plus up to ~10 keyword-search calls, so remembering the answer
 *    (including "no answer") is where most of the savings come from.
 *
 *  • ASIN → product — identity fields (title/brand/dimensions) are stable, but
 *    price is not, and price feeds both ASIN candidate scoring and export
 *    files. A stale price picks the wrong product, so entries past
 *    PRICE_TTL_MS are still usable for identity while their price is stripped.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { toGtin14 } from "@/lib/barcode";
import type { KeepaProduct } from "./types";

/** How a code→ASIN mapping was resolved. Keyword hits are fuzzy, so they expire. */
export type LookupSource = "batch" | "rescue" | "keyword";

const DAY = 24 * 60 * 60 * 1000;

/** Confirmed-absent codes: a product may get listed later, so don't trust forever. */
const NEGATIVE_TTL_MS = 30 * DAY;
/** Keyword-derived mappings are a guess, not a barcode match. Re-verify sooner. */
const KEYWORD_TTL_MS = 7 * DAY;
/** Past this, cached identity is still good but the price is not. */
const PRICE_TTL_MS = 12 * 60 * 60 * 1000;

function isFresh(at: Date, ttlMs: number): boolean {
  return Date.now() - at.getTime() < ttlMs;
}

/**
 * Master kill switch. When set, the cache is fully bypassed: reads return
 * nothing (so every lookup re-fetches from Keepa) and writes are no-ops (so
 * nothing is ever stored). Trades API cost/latency for zero cache storage — set
 * `CACHE_DISABLED=true` to keep the DB from growing. Flip it back off to restore
 * caching with no other code change.
 */
const CACHE_DISABLED = process.env.CACHE_DISABLED === "true";

/**
 * Look up cached code→ASIN mappings.
 *
 * Returns only entries still considered valid; expired negatives and stale
 * keyword guesses are omitted so the caller re-fetches them. Codes absent from
 * the result map were never cached and must be fetched.
 */
export async function getCachedCodeLookups(
  domain: number,
  codes: string[],
): Promise<Map<string, string[]>> {
  if (CACHE_DISABLED) return new Map();
  const keys = [...new Set(codes.map(toGtin14).filter((c): c is string => !!c))];
  if (!keys.length) return new Map();

  const rows = await prisma.keepaCodeLookup.findMany({
    where: { domain, code: { in: keys } },
  });

  const out = new Map<string, string[]>();
  for (const r of rows) {
    // An empty keyword row records "the search cascade failed once", NOT
    // "Amazon doesn't carry this barcode" — a fuzzy search finding nothing is
    // no evidence about a barcode. Treating it as an absence made re-verifies
    // report live products as not_found after one bad cascade. These rows are
    // only meaningful to getCachedCascadeFailures below.
    if (r.source === "keyword" && !r.asins.length) continue;
    // A remembered "not on Amazon" is only good for so long.
    if (!r.asins.length && !isFresh(r.fetchedAt, NEGATIVE_TTL_MS)) continue;
    // Keyword matches were never authoritative — re-confirm them periodically.
    if (r.source === "keyword" && !isFresh(r.fetchedAt, KEYWORD_TTL_MS)) continue;
    out.set(r.code, r.asins);
  }
  return out;
}

/**
 * Codes whose keyword-search cascade already ran to completion and found
 * nothing (within the keyword TTL). Deliberately source-scoped: an empty
 * batch/rescue row means "Keepa doesn't map this barcode", which says nothing
 * about what a keyword search would find — only a keyword-source empty proves
 * the cascade itself came up dry, so only those may skip a re-run.
 */
export async function getCachedCascadeFailures(
  domain: number,
  codes: string[],
): Promise<Set<string>> {
  if (CACHE_DISABLED) return new Set();
  const keys = [...new Set(codes.map(toGtin14).filter((c): c is string => !!c))];
  if (!keys.length) return new Set();

  const rows = await prisma.keepaCodeLookup.findMany({
    where: { domain, code: { in: keys }, source: "keyword", asins: { isEmpty: true } },
  });
  return new Set(rows.filter((r) => isFresh(r.fetchedAt, KEYWORD_TTL_MS)).map((r) => r.code));
}

/**
 * Record how a code resolved. Pass an empty `asins` to record a confirmed
 * absence — but only when Keepa actually answered. A failed request means we
 * never asked, and storing that as "absent" would poison the cache with an
 * outage.
 */
export async function cacheCodeLookup(
  domain: number,
  rawCode: string,
  asins: string[],
  source: LookupSource,
): Promise<void> {
  if (CACHE_DISABLED) return;
  const code = toGtin14(rawCode);
  if (!code) return;
  const data = { asins, source, fetchedAt: new Date() };
  try {
    if (source === "keyword" && !asins.length) {
      // A cascade failure must never overwrite a real code→ASIN mapping: the
      // batch/rescue row shares this primary key, and clobbering it turned
      // UPCs Keepa knows into permanent not_founds. Insert the memo only when
      // there is no better fact already stored.
      await prisma.$executeRaw`
        INSERT INTO "KeepaCodeLookup" ("code", "domain", "asins", "source", "fetchedAt")
        VALUES (${code}, ${domain}, ${asins}::text[], ${source}, NOW())
        ON CONFLICT ("code", "domain") DO UPDATE
          SET "source" = EXCLUDED."source",
              "fetchedAt" = EXCLUDED."fetchedAt"
          WHERE "KeepaCodeLookup"."asins" = '{}'::text[]`;
      return;
    }
    await prisma.keepaCodeLookup.upsert({
      where: { code_domain: { code, domain } },
      create: { code, domain, ...data },
      update: data,
    });
  } catch (e) {
    // A cache write must never fail a verify run.
    console.error("[keepa-cache] code write failed:", (e as Error).message);
  }
}

/** Batch form of {@link cacheCodeLookup} — one statement instead of N. */
export async function cacheCodeLookups(
  domain: number,
  entries: { code: string; asins: string[]; source: LookupSource }[],
): Promise<void> {
  if (CACHE_DISABLED) return;
  const rows = entries
    .map((e) => ({ code: toGtin14(e.code), asins: e.asins, source: e.source }))
    .filter((r): r is { code: string; asins: string[]; source: LookupSource } => !!r.code);
  if (!rows.length) return;

  // Dedupe: the same GTIN-14 can arrive via several barcode variants, and
  // Postgres rejects a multi-row upsert that touches one key twice.
  const byCode = new Map(rows.map((r) => [r.code, r]));
  try {
    // Single bulk upsert — see cacheProducts for why this isn't a transaction.
    const values = Prisma.join(
      [...byCode.values()].map(
        (r) => Prisma.sql`(${r.code}, ${domain}, ${r.asins}::text[], ${r.source}, NOW())`,
      ),
    );
    await prisma.$executeRaw`
      INSERT INTO "KeepaCodeLookup" ("code", "domain", "asins", "source", "fetchedAt")
      VALUES ${values}
      ON CONFLICT ("code", "domain") DO UPDATE
        SET "asins" = EXCLUDED."asins",
            "source" = EXCLUDED."source",
            "fetchedAt" = EXCLUDED."fetchedAt"`;
  } catch (e) {
    console.error("[keepa-cache] code batch write failed:", (e as Error).message);
  }
}

/**
 * Fetch cached raw products by ASIN.
 *
 * Entries whose price has aged past PRICE_TTL_MS are returned with price data
 * stripped rather than discarded: the identity fields are what verification
 * actually compares, and they don't go stale. Dropping the whole row would
 * throw away a good title to avoid a bad price.
 */
export async function getCachedProducts(
  domain: number,
  asins: string[],
): Promise<Map<string, KeepaProduct>> {
  if (CACHE_DISABLED) return new Map();
  const keys = [...new Set(asins.filter(Boolean))];
  if (!keys.length) return new Map();

  const rows = await prisma.keepaProductCache.findMany({
    where: { domain, asin: { in: keys } },
  });

  const out = new Map<string, KeepaProduct>();
  for (const r of rows) {
    const raw = r.raw as unknown as KeepaProduct;
    if (!isFresh(r.priceAt, PRICE_TTL_MS)) {
      // Strip stats so downstream price/rank reads see "unknown" rather than a
      // confidently wrong number from days ago.
      delete (raw as { stats?: unknown }).stats;
    }
    out.set(r.asin, raw);
  }
  return out;
}

/** Store raw Keepa payloads. Never throws — a cache write can't fail a verify. */
export async function cacheProducts(domain: number, products: KeepaProduct[]): Promise<void> {
  if (CACHE_DISABLED) return;
  const rows = products.filter((p) => typeof p.asin === "string" && p.asin);
  if (!rows.length) return;

  const byAsin = new Map(rows.map((p) => [p.asin as string, p]));
  const entries = [...byAsin.entries()];
  try {
    // One statement, not one per row: a per-row transaction makes N network
    // round-trips and blows Prisma's 5s transaction budget on a remote DB.
    const values = Prisma.join(
      entries.map(([asin, raw]) =>
        Prisma.sql`(${asin}, ${domain}, ${JSON.stringify(raw)}::jsonb, NOW(), NOW())`,
      ),
    );
    await prisma.$executeRaw`
      INSERT INTO "KeepaProductCache" ("asin", "domain", "raw", "fetchedAt", "priceAt")
      VALUES ${values}
      ON CONFLICT ("asin", "domain") DO UPDATE
        SET "raw" = EXCLUDED."raw",
            "fetchedAt" = EXCLUDED."fetchedAt",
            "priceAt" = EXCLUDED."priceAt"`;
  } catch (e) {
    console.error("[keepa-cache] product write failed:", (e as Error).message);
  }
}

/** Cache hit-rate accounting for one verify run. */
export type CacheStats = { codeHits: number; codeMisses: number; productHits: number; productMisses: number };

export function newCacheStats(): CacheStats {
  return { codeHits: 0, codeMisses: 0, productHits: 0, productMisses: 0 };
}

/**
 * A cache you can't measure is a cache you can't trust — log the rate so a
 * silently-broken cache shows up as an obviously bad number rather than a
 * quietly rising Keepa bill.
 */
export function logCacheStats(s: CacheStats): void {
  const codeTotal = s.codeHits + s.codeMisses;
  const prodTotal = s.productHits + s.productMisses;
  const pct = (h: number, t: number) => (t ? Math.round((h / t) * 100) : 0);
  console.log(
    `[keepa-cache] codes ${s.codeHits}/${codeTotal} (${pct(s.codeHits, codeTotal)}% hit), ` +
      `products ${s.productHits}/${prodTotal} (${pct(s.productHits, prodTotal)}% hit)`,
  );
}
