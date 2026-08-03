/**
 * Persistent Walmart lookup cache.
 *
 * An unresolved Walmart product costs up to five sequential API round-trips
 * (seller GTIN → affiliate UPC → affiliate brand+name → affiliate name → item
 * detail). Remembering the outcome — including "Walmart has nothing for this
 * code" — is where nearly all the savings on a re-run come from, exactly as
 * with the Keepa cache this mirrors.
 *
 * Three entry kinds share one table, distinguished by `source`:
 *
 *  • seller — our own catalog answered. Authoritative for our listings, but
 *    publish status changes as listings go live, so it ages fastest.
 *  • upc    — affiliate barcode hit. A barcode is product identity; stable.
 *  • name   — affiliate keyword hit. A fuzzy title guess, not an identity
 *    match, so it expires soonest of the positive kinds.
 */
import { prisma } from "@/lib/db";
import { toGtin14 } from "@/lib/barcode";
import { createHash } from "crypto";

export type CacheSource = "seller" | "upc" | "name";

const DAY = 24 * 60 * 60 * 1000;

/** Our own catalog: publish status and price move, so re-confirm daily. */
const SELLER_TTL_MS = 1 * DAY;
/** A barcode→item mapping is effectively permanent identity. */
const UPC_TTL_MS = 14 * DAY;
/** Keyword hits are guesses — re-verify within the week. */
const NAME_TTL_MS = 7 * DAY;
/** A product absent today may be listed tomorrow; don't trust "no" forever. */
const NEGATIVE_TTL_MS = 3 * DAY;

function ttlFor(source: string, isNegative: boolean): number {
  if (isNegative) return NEGATIVE_TTL_MS;
  switch (source) {
    case "seller": return SELLER_TTL_MS;
    case "upc": return UPC_TTL_MS;
    default: return NAME_TTL_MS;
  }
}

function isFresh(at: Date, ttlMs: number): boolean {
  return Date.now() - at.getTime() < ttlMs;
}

/**
 * Cache key for a name-search query. Queries are free-text and can be long, so
 * they're hashed rather than stored raw; the `q:` prefix keeps them from
 * colliding with the GTIN keyspace.
 */
export function queryKey(query: string): string {
  const norm = query.toLowerCase().replace(/\s+/g, " ").trim();
  return "q:" + createHash("sha1").update(norm).digest("hex").slice(0, 24);
}

/** Cache key for a barcode, or null when it doesn't normalize to a GTIN. */
export function codeKey(rawCode: string | null | undefined): string | null {
  return rawCode ? toGtin14(rawCode) : null;
}

export type CachedLookup<T> = { hit: true; item: T | null } | { hit: false };

/**
 * Bulk-read cached lookups. Returns a map of key → payload, where a present key
 * with a null payload is a confirmed absence. Keys missing from the map were
 * never cached (or have expired) and must be fetched.
 */
export async function getCachedItems<T>(keys: string[]): Promise<Map<string, T | null>> {
  const unique = [...new Set(keys.filter(Boolean))];
  if (!unique.length) return new Map();

  const rows = await prisma.walmartItemCache.findMany({
    where: { code: { in: unique } },
  });

  const out = new Map<string, T | null>();
  for (const r of rows) {
    const isNegative = r.item == null;
    if (!isFresh(r.fetchedAt, ttlFor(r.source, isNegative))) continue;
    out.set(r.code, (r.item as T | null) ?? null);
  }
  return out;
}

/**
 * Record a lookup outcome. Pass a null `item` to record a confirmed absence —
 * but only when Walmart actually answered. A network failure means we never
 * asked, and storing that as "absent" would poison the cache with an outage.
 */
export async function cacheItem(
  key: string,
  item: unknown | null,
  source: CacheSource,
): Promise<void> {
  if (!key) return;
  const data = {
    item: (item ?? null) as never,
    source,
    fetchedAt: new Date(),
  };
  await prisma.walmartItemCache
    .upsert({ where: { code: key }, create: { code: key, ...data }, update: data })
    .catch(() => { /* cache writes are best-effort — never fail a run over one */ });
}

/**
 * Bulk-write lookup outcomes. Used at the end of a batch so a 10k run performs a
 * handful of writes instead of one per product.
 */
export async function cacheItems(
  entries: Array<{ key: string; item: unknown | null; source: CacheSource }>,
): Promise<void> {
  const valid = entries.filter((e) => e.key);
  if (!valid.length) return;

  // Deduplicate by key — a batch can resolve the same barcode more than once,
  // and createMany would otherwise fail the whole write on the conflict.
  const byKey = new Map(valid.map((e) => [e.key, e]));
  const now = new Date();
  const rows = [...byKey.values()];

  // Chunked so each transaction stays well inside Prisma's 5s interactive
  // timeout. A whole batch's worth of rows in one transaction exceeds it, and
  // the resulting rollback loses cache entries the run already paid for.
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    // Delete-then-insert: Prisma has no bulk upsert, and this is far cheaper
    // than N round-trip upserts. The pair is transactional so a code is never
    // left deleted-but-not-reinserted.
    await prisma
      .$transaction([
        prisma.walmartItemCache.deleteMany({
          where: { code: { in: chunk.map((e) => e.key) } },
        }),
        prisma.walmartItemCache.createMany({
          data: chunk.map((e) => ({
            code: e.key,
            item: (e.item ?? null) as never,
            source: e.source,
            fetchedAt: now,
          })),
          skipDuplicates: true,
        }),
      ])
      .catch(() => { /* best-effort — a lost cache entry only costs a refetch */ });
  }
}

export type WalmartCacheStats = { hits: number; misses: number; negativeHits: number };

export function newWalmartCacheStats(): WalmartCacheStats {
  return { hits: 0, misses: 0, negativeHits: 0 };
}

export function logWalmartCacheStats(s: WalmartCacheStats): void {
  const total = s.hits + s.misses;
  if (!total) return;
  const pct = ((s.hits / total) * 100).toFixed(0);
  console.log(
    `[walmart-cache] ${s.hits}/${total} hits (${pct}%), ` +
      `${s.negativeHits} known-absent, ${s.misses} fetched`,
  );
}
