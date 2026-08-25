import { createSign } from "crypto";
import { fetchWithRetry, RateLimitError } from "./throttle";

const BASE = "https://developer.api.walmart.com/api-proxy/service/affil/product/v2";

export type WalmartItem = {
  itemId?: string;
  upc?: string;
  name?: string;
  brandName?: string;
  /** Manufacturer part/model number — an exact match here is an identity match. */
  modelNumber?: string;
  salePrice?: number;
  msrp?: number;
  thumbnailImage?: string;
  largeImage?: string;
  shortDescription?: string;
  longDescription?: string;
  categoryPath?: string;
  imageEntities?: Array<{ largeImage?: string; thumbnailImage?: string; entityType?: string }>;
};

function generateAuthHeaders(): Record<string, string> {
  const consumerId = process.env.WALMART_AFFILIATE_CONSUMER_ID;
  const privateKeyRaw = process.env.WALMART_AFFILIATE_PRIVATE_KEY;
  const keyVersion = process.env.WALMART_AFFILIATE_KEY_VERSION ?? "1";

  if (!consumerId || !privateKeyRaw) {
    throw new Error("WALMART_AFFILIATE_CONSUMER_ID / WALMART_AFFILIATE_PRIVATE_KEY not configured");
  }

  const timestamp = String(Date.now());

  // Sort headers alphabetically by key name (required by Walmart)
  const headersToSign: [string, string][] = [
    ["WM_CONSUMER.ID", consumerId],
    ["WM_CONSUMER.INTIMESTAMP", timestamp],
    ["WM_SEC.KEY_VERSION", keyVersion],
  ];
  headersToSign.sort((a, b) => a[0].localeCompare(b[0]));

  // Canonical string: sorted values joined by "\n" + trailing "\n"
  const canonicalString = headersToSign.map(([, v]) => v.trim()).join("\n") + "\n";

  // Handle env vars where newlines may be stored as literal \n
  const pemKey = privateKeyRaw.replace(/\\n/g, "\n");

  const signer = createSign("SHA256");
  signer.update(canonicalString);
  const signature = signer.sign(pemKey, "base64");

  const result: Record<string, string> = {};
  for (const [k, v] of headersToSign) result[k] = v;
  result["WM_SEC.AUTH_SIGNATURE"] = signature;
  result["Accept"] = "application/json";
  return result;
}

function normalizeUpc(upc: string): string {
  const digits = upc.replace(/\D/g, "");
  // UPC-A is 12 digits; many vendor files drop the leading zero — restore it
  if (digits.length === 11) return "0" + digits;
  return digits;
}

/**
 * Returns the item on a hit, null when Walmart ANSWERED and had nothing, and
 * undefined when the lookup itself failed (missing credentials, HTTP error,
 * network). Callers must not cache undefined as an absence — a failure means
 * we never asked, and remembering it as "not on Walmart" poisons the cache
 * for days after the outage ends.
 */
export async function searchWalmartByUpc(upc: string): Promise<WalmartItem | null | undefined> {
  const normalized = normalizeUpc(upc);
  try {
    const headers = generateAuthHeaders();
    const res = await fetchWithRetry(`${BASE}/items?upc=${encodeURIComponent(normalized)}`, { headers });
    if (!res.ok) {
      console.error(`[walmart] UPC search ${res.status}:`, await res.text().catch(() => ""));
      return undefined;
    }
    const data = await res.json() as Record<string, unknown>;
    const items = (data.items as WalmartItem[] | undefined) ?? [];
    const exact = items.find((i) => normalizeUpc(i.upc ?? "") === normalized);
    if (exact) return exact;
    // A response whose items carry a DIFFERENT barcode is not our product —
    // Walmart sometimes answers a UPC query with related items. Falling back to
    // items[0] here silently swapped in a sibling SKU, so prefer an item with no
    // barcode at all (unverifiable, reported as such) over one that contradicts.
    const noUpc = items.find((i) => !normalizeUpc(i.upc ?? ""));
    if (noUpc) return noUpc;
    return null;
  } catch (e) {
    if (e instanceof RateLimitError) throw e; // let the limiter see the pushback
    console.error("[walmart] UPC search error:", e);
    return undefined;
  }
}

/**
 * Keyword search. By default this costs ONE request and returns the search hit
 * as-is.
 *
 * `withDetails` adds a second request to pull the full item record, whose only
 * meaningful addition is `imageEntities` (the alternate camera angles). That
 * doubles the cost of every name search, so it is opt-in: callers that will
 * actually consume the extra angles — i.e. the AI image-comparison pass — ask
 * for it, and a plain field-comparison run does not.
 */
export async function searchWalmartByName(
  query: string,
  opts?: { withDetails?: boolean },
): Promise<WalmartItem | null> {
  try {
    const headers = generateAuthHeaders();
    const res = await fetchWithRetry(
      `${BASE}/search?query=${encodeURIComponent(query)}&numItems=5`,
      { headers },
    );
    if (!res.ok) {
      console.error(`[walmart] Name search ${res.status}:`, await res.text().catch(() => ""));
      return null;
    }
    const data = await res.json() as Record<string, unknown>;
    const search = data.search as Record<string, unknown> | undefined;
    const items =
      (search?.items as WalmartItem[] | undefined) ??
      (data.items as WalmartItem[] | undefined) ??
      [];
    const first = items[0] ?? null;
    if (opts?.withDetails && first?.itemId) {
      const full = await fetchWalmartItemById(first.itemId).catch(() => null);
      if (full) return full;
    }
    return first;
  } catch (e) {
    if (e instanceof RateLimitError) throw e; // let the limiter see the pushback
    console.error("[walmart] Name search error:", e);
    return null;
  }
}

/**
 * Keyword search returning ALL candidates rather than just the first hit.
 *
 * Walmart's relevance ranking is not identity: for a query like
 * "Bon 11-482 Flat Slicker" it will happily rank a sibling SKU from the same
 * product family first. Taking `items[0]` on faith is what produced ~1700 wrong
 * matches in a real 7k run — adjacent model numbers, different sizes.
 *
 * Handing the caller every candidate lets it pick by evidence (barcode, model
 * code, title) instead of by position, and reject the whole result set when
 * nothing is actually the product being looked for.
 *
 * Returns [] when Walmart answered with no candidates, undefined when the
 * search itself failed — the same do-not-cache-failures contract as
 * searchWalmartByUpc.
 */
export async function searchWalmartCandidates(query: string): Promise<WalmartItem[] | undefined> {
  try {
    const headers = generateAuthHeaders();
    const res = await fetchWithRetry(
      `${BASE}/search?query=${encodeURIComponent(query)}&numItems=10`,
      { headers },
    );
    if (!res.ok) {
      console.error(`[walmart] Name search ${res.status}:`, await res.text().catch(() => ""));
      return undefined;
    }
    const data = await res.json() as Record<string, unknown>;
    const search = data.search as Record<string, unknown> | undefined;
    return (
      (search?.items as WalmartItem[] | undefined) ??
      (data.items as WalmartItem[] | undefined) ??
      []
    );
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    console.error("[walmart] Name search error:", e);
    return undefined;
  }
}

export async function fetchWalmartItemById(itemId: string): Promise<WalmartItem | null> {
  try {
    const headers = generateAuthHeaders();
    const res = await fetchWithRetry(`${BASE}/items?ids=${encodeURIComponent(itemId)}`, { headers });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const items = (data.items as WalmartItem[] | undefined) ?? [];
    return items[0] ?? null;
  } catch {
    return null;
  }
}
