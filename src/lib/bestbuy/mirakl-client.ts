// ── Best Buy marketplace (Mirakl) seller API ─────────────────────────────────
// Best Buy's US marketplace runs on Mirakl (bestbuyus-prod.mirakl.net). Three
// endpoints matter for listing products:
//
//   H11  GET /api/hierarchies            the category tree (4 levels, ~1,678
//                                        nodes, 1,450 leaves)
//   PM11 GET /api/products/attributes    the attributes for ONE category —
//                                        this is what a downloadable category
//                                        "template" actually IS
//   VL11 GET /api/values_lists           allowed values for list attributes
//
// Auth is a raw API key in the Authorization header — NOT "Bearer <key>",
// which is the usual first mistake with Mirakl.

const TIMEOUT_MS = 30_000;

export class MiraklError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MiraklError";
  }
}

function baseUrl(): string {
  return (process.env.BESTBUY_MIRAKL_URL ?? "").trim().replace(/\/+$/, "");
}

function apiKey(): string {
  return (process.env.BESTBUY_MIRAKL_KEY ?? "").trim();
}

/** True when both the marketplace URL and the seller API key are configured. */
export function miraklConfigured(): boolean {
  return !!baseUrl() && !!apiKey();
}

async function call<T>(path: string): Promise<T> {
  if (!miraklConfigured()) {
    throw new MiraklError("BESTBUY_MIRAKL_URL / BESTBUY_MIRAKL_KEY not configured", 401);
  }
  const res = await fetch(`${baseUrl()}${path}`, {
    headers: { Authorization: apiKey(), Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((e) => {
    throw new MiraklError(`Could not reach Best Buy Mirakl: ${(e as Error).message}`, 502);
  });

  const text = await res.text();
  if (!res.ok) {
    throw new MiraklError(`Mirakl ${path} failed (HTTP ${res.status}): ${text.slice(0, 200)}`, res.status);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new MiraklError(`Mirakl ${path} returned non-JSON: ${text.slice(0, 120)}`, res.status);
  }
}

// ── H11: the category tree ───────────────────────────────────────────────────

export type MiraklHierarchy = {
  code: string;
  label: string;
  level: number;
  parent_code?: string;
};

/** Every category node Best Buy exposes, flat. Parent links are by `code`. */
export async function getHierarchies(): Promise<MiraklHierarchy[]> {
  const json = await call<{ hierarchies?: MiraklHierarchy[] }>("/api/hierarchies");
  return json.hierarchies ?? [];
}

/**
 * The tree as full leaf paths ("Automotive > Car Audio > Car Amplifiers"),
 * which is the shape the categorization prompt and validation both use.
 *
 * A LEAF is a node with no children — Best Buy's tree is ragged, so leaves sit
 * at level 3 as well as level 4 and a depth-4-only filter would silently drop
 * hundreds of perfectly valid categories.
 */
export function hierarchiesToLeafPaths(nodes: MiraklHierarchy[]): Array<{ code: string; path: string }> {
  const byCode = new Map(nodes.map((n) => [n.code, n]));
  const hasChild = new Set(nodes.map((n) => n.parent_code).filter((c): c is string => !!c));

  const pathOf = (node: MiraklHierarchy): string => {
    const parts: string[] = [];
    let cur: MiraklHierarchy | undefined = node;
    const seen = new Set<string>(); // ragged data + a cycle would hang the walk
    while (cur && !seen.has(cur.code)) {
      seen.add(cur.code);
      parts.unshift(cur.label || cur.code);
      cur = cur.parent_code ? byCode.get(cur.parent_code) : undefined;
    }
    return parts.join(" > ");
  };

  return nodes
    .filter((n) => !hasChild.has(n.code))
    .map((n) => ({ code: n.code, path: pathOf(n) }))
    .filter((x) => !!x.path);
}

// ── PM11: per-category attributes (what a "template" really is) ──────────────

export type MiraklAttribute = {
  code: string;
  label: string;
  type?: string;
  required: boolean;
  requirement_level?: string;
  description?: string;
  example?: string | null;
  hierarchy_code?: string;
  values_list_code?: string;
  default_value?: unknown;
};

/**
 * The attribute configuration for ONE category. `max_level=0` keeps the answer
 * to this category only rather than every descendant — without it a top-level
 * code returns the union of the whole branch, which is not what any single
 * product sheet needs.
 */
export async function getCategoryAttributes(hierarchyCode: string): Promise<MiraklAttribute[]> {
  const json = await call<{ attributes?: MiraklAttribute[] }>(
    `/api/products/attributes?hierarchy=${encodeURIComponent(hierarchyCode)}&max_level=0`,
  );
  return json.attributes ?? [];
}

// ── VL11: allowed values for list-typed attributes ───────────────────────────

export type MiraklValueList = { code: string; values: Array<{ code: string; label: string }> };

export async function getValuesList(code: string): Promise<MiraklValueList | null> {
  try {
    const json = await call<{ values_lists?: MiraklValueList[] }>(
      `/api/values_lists?values_list_codes=${encodeURIComponent(code)}`,
    );
    return json.values_lists?.[0] ?? null;
  } catch (e) {
    console.warn(`[mirakl] values list ${code} failed:`, (e as Error).message);
    return null;
  }
}
