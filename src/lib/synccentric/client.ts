import type { KeepaCategoryTreeEntry, KeepaProduct } from "@/lib/keepa/types";

/**
 * Synccentric database-search client — fallback product source for Amazon
 * verification when Keepa tokens run out.
 *
 * Uses the instant `GET /api/v3/products/search` endpoint (Synccentric's own
 * 100M+ product database, not the async real-time campaign flow). Results are
 * mapped into minimal `KeepaProduct` objects so the existing normalize +
 * verify pipeline consumes them unchanged. The mapping is intentionally
 * partial: price/stats/rank history and physical dimensions are omitted
 * (Synccentric reports dimensions in unknown units — wrong-unit values would
 * produce false verify mismatches), so synthetic products must NOT be written
 * into the Keepa product cache where they would mask a richer Keepa payload.
 *
 * Auth: `SYNCCENTRIC_API_TOKEN` (Bearer). Daily quota by plan (resets 12am
 * Central); the X-Sync-Search-* response headers carry the running balance.
 */

const BASE = "https://app.synccentric.com/api/v3";

export class SynccentricError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SynccentricError";
    this.status = status;
  }
}

/** Token from the environment, tolerating surrounding quotes/whitespace —
 *  dashboard env editors (Render) take pasted quotes literally, and a quoted
 *  Bearer value fails auth in a way that's invisible until runtime. */
function apiToken(): string {
  return (process.env.SYNCCENTRIC_API_TOKEN ?? "").trim().replace(/^["']+|["']+$/g, "");
}

export function synccentricConfigured(): boolean {
  return !!apiToken();
}

/** Synccentric-first is the DEFAULT whenever a token is configured: Synccentric
 *  answers Amazon product lookups and Keepa only covers what it misses —
 *  conserving Keepa tokens at the cost of Synccentric's shallower,
 *  snapshot-based data (no price/rank history, no dimensions; the verify
 *  pipeline backfills rank/review/pack signals from Keepa where a pick is
 *  ambiguous). Set SYNCCENTRIC_PRIMARY=0 to flip back to Keepa-led with
 *  Synccentric as the token-starved fallback. */
export function synccentricPrimary(): boolean {
  return (
    synccentricConfigured() &&
    !/^(0|false|no|off)$/i.test((process.env.SYNCCENTRIC_PRIMARY ?? "").trim())
  );
}

export interface SynccentricQuota {
  limit: number | null;
  used: number | null;
  remaining: number | null;
  timestamp: number;
}

let lastQuota: SynccentricQuota | null = null;
export function getLastSynccentricQuota(): SynccentricQuota | null {
  return lastQuota;
}

function captureQuota(res: Response) {
  const num = (h: string): number | null => {
    const v = Number(res.headers.get(h));
    return Number.isFinite(v) && res.headers.get(h) !== null ? v : null;
  };
  const limit = num("X-Sync-Search-Limit");
  const used = num("X-Sync-Search-Used");
  const remaining = num("X-Sync-Search-Remaining");
  if (limit !== null || used !== null || remaining !== null) {
    lastQuota = { limit, used, remaining, timestamp: Date.now() };
  }
}

/** Fields requested on every search — the subset the verify pipeline reads. */
const FIELDS = [
  "asin",
  "title",
  "brand",
  "manufacturer",
  "description",
  "features",
  "model",
  "part_num",
  "mpn",
  "color",
  "size",
  "upc",
  "ean",
  "parent_asin",
  "package_quantity",
  "large_image",
  "medium_image",
  "additional_image_1",
  "additional_image_2",
  "additional_image_3",
  "additional_image_4",
  "additional_image_5",
  "category",
  "product_group",
] as const;

async function call(params: URLSearchParams): Promise<unknown> {
  const token = apiToken();
  if (!token) throw new SynccentricError("SYNCCENTRIC_API_TOKEN not configured", 401);

  const res = await fetch(`${BASE}/products/search?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(25000),
  }).catch((e) => {
    throw new SynccentricError(`Could not reach Synccentric: ${(e as Error).message}`, 502);
  });
  captureQuota(res);

  const json = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg =
      (json as { message?: string; error?: string } | null)?.message ??
      (json as { error?: string } | null)?.error ??
      `Synccentric request failed (HTTP ${res.status})`;
    throw new SynccentricError(msg, res.status);
  }
  return json;
}

/** Unwrap the response into flat attribute rows, tolerating shape variants
 *  ({data:[...]}, bare array, rows wrapped as {attributes:{...}}). */
function rowsOf(json: unknown): Record<string, unknown>[] {
  const arr = Array.isArray(json)
    ? json
    : Array.isArray((json as { data?: unknown[] })?.data)
      ? (json as { data: unknown[] }).data
      : Array.isArray((json as { products?: unknown[] })?.products)
        ? (json as { products: unknown[] }).products
        : [];
  return arr
    .map((r) => {
      if (r && typeof r === "object" && "attributes" in (r as object)) {
        const a = (r as { attributes?: unknown }).attributes;
        if (a && typeof a === "object") return a as Record<string, unknown>;
      }
      return r as Record<string, unknown>;
    })
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;

/** Amazon image URL → bare filename (Keepa's imagesCSV format expects names
 *  that get prefixed with the m.media-amazon.com base). Non-Amazon URLs are
 *  dropped rather than mangled. */
function imageName(v: unknown): string | null {
  const u = str(v);
  if (!u) return null;
  try {
    const url = new URL(u);
    if (!/amazon/i.test(url.hostname)) return null;
    const name = url.pathname.split("/").pop() ?? "";
    // Strip Amazon size modifiers ("71x._AC_SL1500_.jpg" → "71x.jpg")
    const clean = name.replace(/\._[^.]+_(?=\.)/, "");
    return /\.(jpe?g|png|gif|webp)$/i.test(clean) ? clean : null;
  } catch {
    return null;
  }
}

function toKeepaProduct(row: Record<string, unknown>): KeepaProduct | null {
  const asin = str(row.asin);
  if (!asin || !/^B[0-9A-Z]{9}$|^\d{10}$/.test(asin)) return null;

  const imagesCSV = [
    imageName(row.large_image) ?? imageName(row.medium_image),
    imageName(row.additional_image_1),
    imageName(row.additional_image_2),
    imageName(row.additional_image_3),
    imageName(row.additional_image_4),
    imageName(row.additional_image_5),
  ]
    .filter((n): n is string => !!n)
    .filter((n, i, a) => a.indexOf(n) === i)
    .join(",");

  const features = Array.isArray(row.features)
    ? row.features.map(str).filter((f): f is string => !!f)
    : str(row.features)
      ? [str(row.features) as string]
      : [];

  const catName = str(row.category) ?? str(row.product_group);
  const categoryTree: KeepaCategoryTreeEntry[] | undefined = catName
    ? [{ catId: 0, name: catName }]
    : undefined;

  const upc = str(row.upc);
  const ean = str(row.ean);

  const p: KeepaProduct = {
    asin,
    title: str(row.title) ?? undefined,
    brand: str(row.brand) ?? undefined,
    manufacturer: str(row.manufacturer) ?? undefined,
    parentAsin: str(row.parent_asin) ?? undefined,
    imagesCSV: imagesCSV || undefined,
    categoryTree,
    description: str(row.description) ?? undefined,
    features,
    upcList: upc ? [upc] : [],
    eanList: ean ? [ean] : [],
    model: str(row.model) ?? undefined,
    partNumber: str(row.part_num) ?? str(row.mpn) ?? undefined,
    color: str(row.color) ?? undefined,
    size: str(row.size) ?? undefined,
    packageQuantity:
      typeof row.package_quantity === "number" && row.package_quantity > 0
        ? row.package_quantity
        : undefined,
    // Marker so callers/logs can tell fallback data from real Keepa payloads.
    _source: "synccentric",
  };
  return p;
}

/** Digits-only, leading zeros stripped — barcode equality across UPC-12/EAN-13
 *  zero-padding variants without pulling in the barcode lib. */
const codeKey = (c: string): string => c.replace(/\D/g, "").replace(/^0+/, "");

const MAX_IDENTIFIERS = 10; // hard API limit per request

async function searchBatch(
  identifiers: string[],
  type: "upc" | "ean" | "asin",
): Promise<KeepaProduct[]> {
  const params = new URLSearchParams({ type, locale: "US" });
  for (const id of identifiers) params.append("identifier[]", id);
  for (const f of FIELDS) params.append("fields[]", f);
  const json = await call(params);
  return rowsOf(json)
    .map(toKeepaProduct)
    .filter((p): p is KeepaProduct => !!p);
}

/**
 * Look up products by UPC/EAN barcode. Mirrors the Keepa client contract:
 * returns the products found and the codes that remain unresolved — either the
 * request failed or Synccentric's database has no row whose barcode matches.
 * Unresolved is NOT "Amazon doesn't carry this": Synccentric's collection is
 * incomplete, so callers must treat these as unanswered, never cache them as
 * definitive absences.
 */
export async function searchByCode(
  codes: string[],
): Promise<{ products: KeepaProduct[]; failedCodes: string[] }> {
  const clean = [...new Set(codes.map((c) => c.replace(/\D/g, "")).filter(Boolean))];
  if (!clean.length) return { products: [], failedCodes: [] };

  // Synccentric requires one identifier type per request: split UPC-12 / EAN.
  const upcs = clean.filter((c) => c.length === 12 || c.length === 11);
  const eans = clean.filter((c) => c.length === 13 || c.length === 8);
  const unsupported = clean.filter((c) => !upcs.includes(c) && !eans.includes(c));

  const products: KeepaProduct[] = [];
  const failed: string[] = [...unsupported];

  const groups: Array<{ type: "upc" | "ean"; ids: string[] }> = [];
  for (let i = 0; i < upcs.length; i += MAX_IDENTIFIERS)
    groups.push({ type: "upc", ids: upcs.slice(i, i + MAX_IDENTIFIERS) });
  for (let i = 0; i < eans.length; i += MAX_IDENTIFIERS)
    groups.push({ type: "ean", ids: eans.slice(i, i + MAX_IDENTIFIERS) });

  for (const g of groups) {
    try {
      const found = await searchBatch(g.ids, g.type);
      products.push(...found);
      // A code is resolved when some returned row carries a matching barcode.
      const returned = new Set(
        found.flatMap((p) => [...(p.upcList ?? []), ...(p.eanList ?? [])]).map(codeKey),
      );
      for (const id of g.ids) if (!returned.has(codeKey(id))) failed.push(id);
    } catch (e) {
      console.error(
        `[synccentric] ${g.type} batch failed (${g.ids.length} codes):`,
        (e as Error).message,
      );
      failed.push(...g.ids);
      // Auth/quota failures are systemic — stop burning the remaining batches.
      const status = (e as SynccentricError).status;
      if (status === 401 || status === 403 || status === 429) {
        const rest = groups.slice(groups.indexOf(g) + 1).flatMap((r) => r.ids);
        failed.push(...rest);
        break;
      }
    }
  }
  return { products, failedCodes: failed };
}

/** Look up products by ASIN. Returns whatever the database knows; absent ASINs
 *  are simply missing from the result (same contract as Keepa's getProducts). */
export async function searchByAsin(asins: string[]): Promise<KeepaProduct[]> {
  const clean = [...new Set(asins.filter((a) => /^B[0-9A-Z]{9}$|^\d{10}$/.test(a)))];
  const out: KeepaProduct[] = [];
  for (let i = 0; i < clean.length; i += MAX_IDENTIFIERS) {
    const batch = clean.slice(i, i + MAX_IDENTIFIERS);
    try {
      out.push(...(await searchBatch(batch, "asin")));
    } catch (e) {
      console.error(`[synccentric] asin batch failed (${batch.length}):`, (e as Error).message);
      const status = (e as SynccentricError).status;
      if (status === 401 || status === 403 || status === 429) break;
    }
  }
  return out;
}

/** Cheap connectivity probe (1 search credit): looks up a well-known ASIN. */
export async function testSynccentric(): Promise<{
  ok: boolean;
  message: string;
  remaining?: number | null;
}> {
  try {
    await searchBatch(["B00X4WHP5E"], "asin");
    const q = getLastSynccentricQuota();
    return {
      ok: true,
      message: `Connected.${q?.remaining != null ? ` ${q.remaining} searches left today.` : ""}`,
      remaining: q?.remaining ?? null,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
