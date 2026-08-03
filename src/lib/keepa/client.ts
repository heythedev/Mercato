import type { KeepaProduct, KeepaTokenInfo } from "./types";

const BASE = "https://api.keepa.com";

export class KeepaError extends Error {
  status?: number;
  code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "KeepaError";
    this.status = status;
    this.code = code;
  }
}

let lastToken: KeepaTokenInfo | null = null;
export function getLastTokenInfo(): KeepaTokenInfo | null { return lastToken; }
export async function refreshKeepaTokens(): Promise<KeepaTokenInfo | null> {
  try { await call("token", {}); } catch { /* keep last snapshot */ }
  return lastToken;
}

/** Typical Keepa cost for ASIN/UPC product lookups (base + rating). */
export const KEEPA_TOKENS_PER_PRODUCT = 2;
/** No extra start buffer — require only the tokens the estimate actually needs. */
export const KEEPA_VERIFY_TOKEN_BUFFER = 0;

/** Estimate Keepa tokens for an Amazon verify. */
export function estimateAmazonVerifyTokens(productCount: number): {
  estimated: number;
  required: number;
} {
  const estimated = Math.max(0, productCount) * KEEPA_TOKENS_PER_PRODUCT;
  return { estimated, required: estimated + KEEPA_VERIFY_TOKEN_BUFFER };
}

function getKey(): string {
  const key = process.env.KEEPA_API_KEY;
  if (!key) throw new KeepaError("KEEPA_API_KEY not configured in .env", 401, "NO_KEY");
  return key;
}

/**
 * Cumulative tokens Keepa has reported consuming, process-wide.
 *
 * Read this via {@link tokensSpentSince} rather than diffing `tokensLeft`: the
 * balance refills continuously (refillRate/min), so a start-minus-end
 * subtraction under-reports usage on any run long enough to refill.
 */
let totalConsumed = 0;

/** Snapshot for measuring spend across a span of work. */
export function tokensSpentMark(): number { return totalConsumed; }

/** Tokens actually consumed since a {@link tokensSpentMark} snapshot. */
export function tokensSpentSince(mark: number): number { return totalConsumed - mark; }

function captureTokens(json: Record<string, unknown>) {
  if (typeof json?.tokensLeft === "number") {
    const consumed = json.tokensConsumed as number | undefined;
    if (typeof consumed === "number" && consumed > 0) totalConsumed += consumed;
    lastToken = {
      tokensLeft: json.tokensLeft as number,
      refillIn: (json.refillIn as number) ?? 0,
      refillRate: (json.refillRate as number) ?? 0,
      tokensConsumed: consumed,
      timestamp: Date.now(),
    };
  }
}

async function call(
  path: string,
  params: Record<string, string | number>,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const key = getKey();
  const usp = new URLSearchParams({ key });
  for (const [k, v] of Object.entries(params)) usp.set(k, String(v));
  const url = `${BASE}/${path}?${usp.toString()}`;

  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(25000),
  }).catch((e) => { throw new KeepaError(`Could not reach Keepa: ${(e as Error).message}`, 502, "NETWORK"); });

  const json = await res.json().catch(() => { throw new KeepaError(`Keepa non-JSON response (HTTP ${res.status}).`, res.status); }) as Record<string, unknown>;
  captureTokens(json);

  if (!res.ok || json?.error) {
    const err = json?.error as { message?: string; type?: string } | string | undefined;
    const msg = (typeof err === "object" ? err?.message : err) ?? `Keepa request failed (HTTP ${res.status}).`;
    const type = typeof err === "object" ? err?.type : undefined;
    throw new KeepaError(msg, res.status, type);
  }
  return json;
}

export async function finder(
  domain: number,
  selection: Record<string, unknown>,
): Promise<{ asinList: string[]; total: number; tokens: KeepaTokenInfo | null }> {
  const json = await call("query", { domain }, { method: "POST", body: JSON.stringify(selection) });
  const asinList = (json.asinList as string[]) ?? [];
  return { asinList, total: (json.totalResults as number) ?? asinList.length, tokens: lastToken };
}

export async function getProducts(
  domain: number,
  asins: string[],
  opts?: { stats?: number; rating?: boolean; buybox?: boolean },
): Promise<KeepaProduct[]> {
  if (!asins.length) return [];
  const batches: string[][] = [];
  for (let i = 0; i < asins.length; i += 100) batches.push(asins.slice(i, i + 100));

  const fetchBatch = async (batch: string[]): Promise<KeepaProduct[]> => {
    const params: Record<string, string | number> = { domain, asin: batch.join(","), stats: opts?.stats ?? 180 };
    if (opts?.rating !== false) params.rating = 1;
    if (opts?.buybox) params.buybox = 1;
    const json = await call("product", params);
    return Array.isArray(json.products) ? (json.products as KeepaProduct[]) : [];
  };

  const out: KeepaProduct[] = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const group = batches.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(group.map(fetchBatch));
    let errored = false;
    for (const s of settled) {
      // Keep every successful batch: a sibling's failure says nothing about
      // the results already in hand.
      if (s.status === "fulfilled") out.push(...s.value);
      else { errored = true; console.error("[keepa] asin batch failed:", (s.reason as Error)?.message); }
    }
    // Stop scheduling more work after a failure — likely a systemic problem
    // (auth, rate limit, outage) and further batches would just burn tokens.
    if (errored) break;
    const left = getLastTokenInfo()?.tokensLeft;
    if (left != null && left < 100) break;
  }
  return out;
}

/**
 * Look up products by UPC/EAN barcode.
 *
 * Returns the products found **and** the codes whose batch never completed
 * (network error, Keepa error, or an early stop on low tokens). A caller cannot
 * otherwise tell "Keepa has no product for this code" apart from "we never got
 * to ask" — both look like an absent result. That distinction matters: the
 * former is a fact worth remembering, the latter is a transient failure that
 * must not be cached or treated as a definitive not-found.
 */
export async function getProductsByCode(
  domain: number,
  codes: string[],
  opts?: { stats?: number; rating?: boolean },
): Promise<{ products: KeepaProduct[]; failedCodes: string[] }> {
  if (!codes.length) return { products: [], failedCodes: [] };
  const batches: string[][] = [];
  for (let i = 0; i < codes.length; i += 100) batches.push(codes.slice(i, i + 100));
  const out: KeepaProduct[] = [];
  const failed: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const params: Record<string, string | number> = { domain, code: batch.join(","), stats: opts?.stats ?? 180 };
    if (opts?.rating !== false) params.rating = 1;
    try {
      const json = await call("product", params);
      if (Array.isArray(json.products)) out.push(...(json.products as KeepaProduct[]));
    } catch (e) {
      console.error(`[keepa] code batch failed (${batch.length} codes):`, (e as Error).message);
      failed.push(...batch);
    }
    const left = getLastTokenInfo()?.tokensLeft;
    if (left != null && left < 100) {
      // Out of tokens: the remaining batches were never attempted, so their
      // codes are unresolved rather than absent.
      for (const rest of batches.slice(i + 1)) failed.push(...rest);
      break;
    }
  }
  return { products: out, failedCodes: failed };
}

export async function keywordSearch(domain: number, term: string): Promise<{ asinList: string[]; products?: KeepaProduct[] }> {
  const json = await call("search", { domain, type: "product", term });
  return { asinList: (json.asinList as string[]) ?? [], products: json.products as KeepaProduct[] | undefined };
}

export async function searchCategories(domain: number, term: string): Promise<{ catId: number; name: string }[]> {
  const json = await call("search", { domain, type: "category", term });
  const cats = (json.categories as Record<string, { name?: string }>) ?? {};
  return Object.entries(cats).map(([catId, c]) => ({ catId: Number(catId), name: c?.name ?? String(catId) }));
}

export async function bestSellers(domain: number, category: number): Promise<string[]> {
  const json = await call("bestsellers", { domain, category });
  const bsl = json.bestSellersList as { asinList?: string[] } | undefined;
  return bsl?.asinList ?? (json.asinList as string[]) ?? [];
}

export async function sellerProducts(domain: number, sellerId: string): Promise<{ asinList: string[]; name: string | null }> {
  const json = await call("seller", { domain, seller: sellerId, storefront: 1 });
  const sellers = json.sellers as Record<string, { asinList?: string[]; sellerName?: string }> | undefined;
  const s = sellers?.[sellerId];
  return { asinList: s?.asinList ?? [], name: s?.sellerName ?? null };
}

export async function testKeepa(): Promise<{ ok: boolean; tokensLeft?: number; message: string }> {
  try {
    const json = await call("token", {});
    captureTokens(json);
    return { ok: true, tokensLeft: (json.tokensLeft as number) ?? lastToken?.tokensLeft, message: `Connected. ${(json.tokensLeft as number) ?? "?"} tokens left.` };
  } catch (e) {
    return { ok: false, message: (e as KeepaError).message };
  }
}
