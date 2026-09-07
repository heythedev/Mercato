import { prisma } from "@/lib/db";

// ── Cross-project category reuse ──────────────────────────────────────────────
// categorize.ts's own `categorizationCache` is an in-memory Map: it saves a
// repeated call within ONE invocation on the SAME server instance, but dies on
// cold start and never sees a name categorized under a DIFFERENT project. The
// Product table itself is the durable record of every judgment this app has
// ever made, so it doubles as a free, always-current cache with no extra
// storage: before paying for a fresh AI call, check whether this exact product
// name has already been categorized (confidently) anywhere else for the same
// marketplace, and reuse that verdict directly — same category, same
// spec type, same confidence, just free the second time.
//
// Scope deliberately mirrors the in-memory cache's own match key (marketplace +
// normalized name) rather than widening it (e.g. to fuzzy matching): the risk
// profile is identical to what the in-memory cache already accepts today, just
// remembered for longer.

export type ReusableCategory = {
  category: string;
  path: string;
  confidence: number;
  specProductType: string | null;
};

/** Normalize a product name the same way for both the lookup key and the query. */
export function normalizeProductName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

const CHUNK = 500; // keeps the ANY(...) array well under any practical size limit

/**
 * Look up already-categorized products (any OTHER project, same marketplace)
 * whose normalized name matches one of `names`, and are confident enough to
 * trust (matches the AI pipeline's own MIN_CONFIDENCE floor and excludes the
 * "Uncategorized" sentinel). Ties broken by most-recently categorized.
 *
 * Returns a Map keyed by the SAME normalized form `normalizeProductName`
 * produces, so callers can look up with `normalizeProductName(p.name)`.
 * Never throws — a lookup failure just means the AI runs as if this cache
 * didn't exist, which is exactly today's behavior.
 */
export async function findReusableCategories(
  marketplace: string,
  excludeProjectId: string,
  names: string[],
): Promise<Map<string, ReusableCategory>> {
  const out = new Map<string, ReusableCategory>();
  const normSet = new Set(names.map(normalizeProductName).filter(Boolean));
  if (!normSet.size) return out;
  const normNames = [...normSet];

  try {
    for (let i = 0; i < normNames.length; i += CHUNK) {
      const slice = normNames.slice(i, i + CHUNK);
      const rows = await prisma.$queryRaw<
        Array<{
          norm_name: string;
          category: string;
          path: string | null;
          confidence: number;
          spec_type: string | null;
        }>
      >`
        SELECT DISTINCT ON (norm_name)
          norm_name, category, path, confidence, spec_type
        FROM (
          SELECT
            lower(regexp_replace(trim(pr.name), '[[:space:]]+', ' ', 'g')) AS norm_name,
            pr."marketplaceCategory" AS category,
            pr."categoryPath" AS path,
            pr."categoryConfidence" AS confidence,
            pr."specProductType" AS spec_type,
            pr."categorizedAt" AS categorized_at
          FROM "Product" pr
          JOIN "Project" pj ON pj.id = pr."projectId"
          WHERE pr."projectId" <> ${excludeProjectId}
            AND lower(pj.marketplace) = ${marketplace.toLowerCase()}
            AND pr."marketplaceCategory" IS NOT NULL
            AND pr."marketplaceCategory" <> 'Uncategorized'
            AND pr."categoryConfidence" > 0.6
            AND lower(regexp_replace(trim(pr.name), '[[:space:]]+', ' ', 'g')) = ANY(${slice}::text[])
        ) matched
        ORDER BY norm_name, categorized_at DESC NULLS LAST`;
      for (const r of rows) {
        out.set(r.norm_name, {
          category: r.category,
          path: r.path ?? r.category,
          confidence: r.confidence,
          specProductType: r.spec_type,
        });
      }
    }
  } catch (e) {
    console.error("[category-reuse] lookup failed — proceeding without it:", e);
    return new Map();
  }
  return out;
}

// ── Cross-project SKU identity reuse ─────────────────────────────────────────
// The twin of the above for a product's IDENTITY rather than its category. A
// vendor sheet that is nothing but bare codes ("VIDA-134814") gives every
// resolver nothing to work with — unless some OTHER upload, in any project,
// already carried the full record for the exact same vendor SKU. That happens
// constantly: the same wholesale catalog gets exported once with every column
// (name, description, UPC, images) for one marketplace and once as a bare SKU
// list for another. The Product table already holds the first export, so the
// second can be filled from it for free — no network, no AI, no guessing:
// an exact SKU match on the vendor's own code is as authoritative as the
// vendor catalog itself.
//
// Unlike category reuse this is NOT marketplace-scoped: what a product IS
// doesn't depend on where it's being listed (the real-world case that
// motivated this was a Walmart upload filling a Mathis one). It carries only
// product-identity fields — name, brand, description, UPC, main image — and
// deliberately nothing from the source row's vendorData beyond those: that
// blob holds the client's own cost/price/commission/listing-note fields,
// which have no business crossing into another project.

export type ResolvedSkuIdentity = {
  name: string;
  brand: string | null;
  description: string | null;
  upc: string | null;
  imageUrl: string | null;
};

/** Normalize a vendor SKU the same way for both the lookup key and the query. */
export function normalizeSku(sku: string): string {
  return sku.trim().toLowerCase();
}

/**
 * Look up products in any OTHER project (any user, any marketplace) whose
 * vendor SKU exactly matches one of `skus` and that carry a real name for it
 * (a name that is not simply the SKU itself — the cheap SQL-side guard; the
 * caller applies looksLikeSkuName as the full one). Ties broken by most
 * recently updated. Returns a Map keyed by `normalizeSku(sku)`. Never throws.
 */
export async function findResolvedNamesBySku(
  excludeProjectId: string,
  skus: string[],
): Promise<Map<string, ResolvedSkuIdentity>> {
  const out = new Map<string, ResolvedSkuIdentity>();
  const normSet = new Set(skus.map(normalizeSku).filter(Boolean));
  if (!normSet.size) return out;
  const normSkus = [...normSet];

  try {
    for (let i = 0; i < normSkus.length; i += CHUNK) {
      const slice = normSkus.slice(i, i + CHUNK);
      const rows = await prisma.$queryRaw<
        Array<{
          norm_sku: string;
          name: string;
          brand: string | null;
          description: string | null;
          upc: string | null;
          image_url: string | null;
        }>
      >`
        SELECT DISTINCT ON (norm_sku)
          norm_sku, name, brand, description, upc, image_url
        FROM (
          SELECT
            lower(trim(pr."vendorSku")) AS norm_sku,
            pr.name AS name,
            pr.brand AS brand,
            pr.description AS description,
            pr.upc AS upc,
            pr."imageUrl" AS image_url,
            pr."updatedAt" AS updated_at
          FROM "Product" pr
          WHERE pr."projectId" <> ${excludeProjectId}
            AND pr."vendorSku" IS NOT NULL
            AND pr.name IS NOT NULL
            AND trim(pr.name) <> ''
            AND lower(trim(pr.name)) <> lower(trim(pr."vendorSku"))
            AND lower(trim(pr."vendorSku")) = ANY(${slice}::text[])
        ) matched
        ORDER BY norm_sku, updated_at DESC NULLS LAST`;
      for (const r of rows) {
        out.set(r.norm_sku, {
          name: r.name,
          brand: r.brand,
          description: r.description,
          upc: r.upc,
          imageUrl: r.image_url,
        });
      }
    }
  } catch (e) {
    console.error("[sku-reuse] lookup failed — proceeding without it:", e);
    return new Map();
  }
  return out;
}
