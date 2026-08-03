import { randomUUID } from "crypto";
import { toGtin14 } from "@/lib/barcode";
import { fetchWithRetry, RateLimitError } from "./throttle";

// Walmart Marketplace (Seller) API. Unlike the Affiliate API in ./client.ts —
// which searches Walmart's first-party retail catalog — this reads the SELLER's
// own published catalog, so it can authoritatively confirm whether one of our
// listings is live, including brand-new listings the Affiliate index has not
// picked up yet.
const BASE = "https://marketplace.walmartapis.com";
const SVC_NAME = "Walmart Marketplace";

export type SellerItem = {
  sku?: string;
  gtin?: string;
  upc?: string;
  productName?: string;
  brand?: string;
  price?: number;
  publishedStatus?: string; // "PUBLISHED" | "UNPUBLISHED" | "STAGE" | "IN_PROGRESS" | "SYSTEM_PROBLEM" | ...
  productType?: string;
  mainImageUrl?: string;
  images?: string[];
  wpid?: string;
  itemId?: string;
};

// ── Access-token cache ────────────────────────────────────────────────────────
// Marketplace access tokens live 15 minutes. Fetching one per product would add
// a round-trip to every lookup and quickly hit the token endpoint's own limits,
// so we cache the token in-process and refresh it a minute before expiry.

let cachedToken: { token: string; expiresAt: number } | null = null;
let inFlight: Promise<string> | null = null;

async function fetchToken(): Promise<string> {
  const clientId = process.env.WALMART_CLIENT_ID;
  const clientSecret = process.env.WALMART_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("WALMART_CLIENT_ID / WALMART_CLIENT_SECRET not configured");
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(`${BASE}/v3/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "WM_SVC.NAME": SVC_NAME,
      "WM_QOS.CORRELATION_ID": randomUUID(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...(process.env.WALMART_CHANNEL_TYPE_ID
        ? { "WM_CONSUMER.CHANNEL.TYPE": process.env.WALMART_CHANNEL_TYPE_ID }
        : {}),
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Walmart token request failed ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Walmart token response missing access_token");

  const ttlMs = (data.expires_in ?? 900) * 1000;
  // Refresh 60s early so a token never expires mid-request.
  cachedToken = { token: data.access_token, expiresAt: Date.now() + ttlMs - 60_000 };
  return data.access_token;
}

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  // Collapse concurrent refreshes (a batch starts many lookups at once) into a
  // single token request.
  if (!inFlight) {
    inFlight = fetchToken().finally(() => { inFlight = null; });
  }
  return inFlight;
}

/** True when the seller credentials are present — lets callers skip the path entirely. */
export function sellerApiConfigured(): boolean {
  return !!(process.env.WALMART_CLIENT_ID && process.env.WALMART_CLIENT_SECRET);
}

// ── Item lookup ───────────────────────────────────────────────────────────────

function normalizeItem(raw: Record<string, unknown>): SellerItem {
  const asStr = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  const asNum = (v: unknown): number | undefined => {
    const n = typeof v === "number" ? v : parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : undefined;
  };
  // Price shape varies: sometimes { price: { amount } }, sometimes flat.
  const priceObj = raw.price as Record<string, unknown> | undefined;
  const price = asNum(priceObj?.amount) ?? asNum(raw.price);

  const images: string[] = [];
  const main = asStr(raw.mainImageUrl);
  if (main) images.push(main);
  if (Array.isArray(raw.productSecondaryImageURL)) {
    for (const u of raw.productSecondaryImageURL) {
      const s = asStr(u);
      if (s) images.push(s);
    }
  }

  return {
    sku: asStr(raw.sku),
    gtin: asStr(raw.gtin),
    upc: asStr(raw.upc),
    productName: asStr(raw.productName),
    brand: asStr(raw.brand),
    price,
    publishedStatus: asStr(raw.publishedStatus),
    productType: asStr(raw.productType),
    mainImageUrl: main,
    images: images.length ? images : undefined,
    wpid: asStr(raw.wpid),
    itemId: asStr(raw.itemId) ?? asStr(raw.wpid),
  };
}

async function sellerFetch(path: string): Promise<Record<string, unknown> | null> {
  const token = await getToken();
  const res = await fetchWithRetry(`${BASE}${path}`, {
    headers: {
      "WM_SEC.ACCESS_TOKEN": token,
      "WM_QOS.CORRELATION_ID": randomUUID(),
      "WM_SVC.NAME": SVC_NAME,
      Accept: "application/json",
    },
  });
  if (res.status === 404) return null; // no such item — a normal "not in my catalog" answer
  if (!res.ok) {
    // 401 here means the token/creds are bad — throw so a whole run fails loudly
    // rather than silently reporting every product as not-found.
    if (res.status === 401 || res.status === 403) {
      const body = await res.text().catch(() => "");
      throw new Error(`Walmart Seller API auth failed ${res.status}: ${body.slice(0, 300)}`);
    }
    console.error(`[walmart-seller] ${path} → ${res.status}:`, await res.text().catch(() => ""));
    return null;
  }
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Look up one of OUR published items by GTIN/UPC. Returns the seller item when
 * found in our catalog (regardless of publish status — the caller inspects
 * `publishedStatus`), or null when the code is not in our catalog.
 *
 * Uses /v3/items/search, which queries the seller's own item catalog. Note this
 * is distinct from /v3/items/walmart/search, which searches Walmart's catalog.
 */
export async function getSellerItemByGtin(rawCode: string): Promise<SellerItem | null> {
  const gtin = toGtin14(rawCode);
  if (!gtin) return null;
  try {
    const data = await sellerFetch(`/v3/items/search?gtin=${encodeURIComponent(gtin)}`);
    if (!data) return null;
    // Response shape: { ItemResponse: [ {...} ] } or { items: [...] }.
    const itemResponse =
      (data.ItemResponse as Record<string, unknown>[] | undefined) ??
      (data.items as Record<string, unknown>[] | undefined) ??
      [];
    if (!itemResponse.length) return null;
    return normalizeItem(itemResponse[0]);
  } catch (e) {
    // Auth errors propagate; everything else (network, parse) degrades to null
    // so the caller can fall back to the Affiliate lookup.
    if (e instanceof Error && /auth failed/.test(e.message)) throw e;
    // Rate limiting must also propagate — swallowing it would hide the pushback
    // from the adaptive limiter, which would keep widening into a wall of 429s.
    if (e instanceof RateLimitError) throw e;
    console.error("[walmart-seller] GTIN lookup error:", e);
    return null;
  }
}

// ── Product-type taxonomy ─────────────────────────────────────────────────────
// GET /v3/items/taxonomy returns Walmart's Product Type (PT) taxonomy — the
// authoritative list of "Spec Product Type" values a new listing may use. This
// list is not embedded in the listing template (the template fetches it
// dynamically), so it must come from the API.

export type WalmartProductType = {
  productType: string;
  productTypeGroup?: string;
  category?: string;
};

/**
 * Fetch and flatten the Product Type taxonomy. Version 5.0 + MP_ITEM returns the
 * PT hierarchy (vs the legacy category taxonomy when version is omitted).
 *
 * The documented response shape is an `itemTaxonomy` array of
 * {category, productTypeGroup, productType}, but the exact envelope isn't
 * pinned in the docs, so this walks the JSON defensively and collects every
 * distinct productType it can find.
 */
export async function getItemTaxonomy(): Promise<WalmartProductType[]> {
  const data = await sellerFetch("/v3/items/taxonomy?version=5.0&feedType=MP_ITEM");
  if (!data) return [];

  const out: WalmartProductType[] = [];
  const seen = new Set<string>();
  const push = (pt: unknown, group?: unknown, cat?: unknown) => {
    const name = typeof pt === "string" ? pt.trim() : "";
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({
      productType: name,
      productTypeGroup: typeof group === "string" ? group : undefined,
      category: typeof cat === "string" ? cat : undefined,
    });
  };

  // Preferred shape: { itemTaxonomy: [{ category, productTypeGroup, productType }] }
  const arr =
    (data.itemTaxonomy as Record<string, unknown>[] | undefined) ??
    (data.taxonomy as Record<string, unknown>[] | undefined) ??
    (data.payload as Record<string, unknown>[] | undefined);
  if (Array.isArray(arr)) {
    for (const row of arr) {
      const pt = row.productType ?? row.productTypeName ?? row.name;
      // productType may itself be an array of names within a group.
      if (Array.isArray(pt)) {
        for (const p of pt) push(p, row.productTypeGroup, row.category);
      } else {
        push(pt, row.productTypeGroup, row.category);
      }
    }
  }

  // Fallback: deep-walk for any "productType" keys if the above found nothing.
  if (!out.length) {
    const walk = (node: unknown) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      for (const [k, v] of Object.entries(node)) {
        if (/^producttype(name)?$/i.test(k)) {
          if (Array.isArray(v)) v.forEach((x) => push(x));
          else push(v);
        } else {
          walk(v);
        }
      }
    };
    walk(data);
  }

  return out;
}
