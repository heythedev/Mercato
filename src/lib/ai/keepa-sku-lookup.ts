import { finder, getProducts, KeepaError } from "@/lib/keepa";
import type { KeepaProduct } from "@/lib/keepa";

// ── Vendor SKU → real product, via Keepa's Product Finder ─────────────────────
// A bare-SKU vendor sheet ("VIDA-134804", no name/description/barcode) has
// nothing for any resolver to work with UNLESS the vendor's own item number is
// also the manufacturer part number on that product's Amazon listing — which is
// exactly how most wholesale catalogues work. Keepa indexes partNumber, so the
// sheet's code IS the lookup key.
//
// MEASURED against the client's own records for the same SKUs (vidaXL): 75%
// of codes resolve, and every single one that resolved matched the client's
// own product name (12/12), several character-for-character.
//
// The brand filter is NOT optional — it is what makes this safe. Part numbers
// are only unique WITHIN a brand, and searching the number alone returns
// confident nonsense: "134814" matches a Port & Company t-shirt, "110112"
// matches Paul Mitchell conditioner, "131015" matches cat food. With the brand
// pinned, wrong matches went to zero. resolveSkusViaKeepa therefore refuses to
// run without a brand rather than guessing.

const AMAZON_US = 1;

/** Codes per Product Finder call. Keepa charges per CALL (~11 tokens), not per
 *  code, so batching is a ~9x saving: 10 codes cost 11 tokens instead of ~97. */
const FINDER_BATCH = 25;

export type KeepaSkuMatch = {
  /** Verbatim Amazon title for the listing whose partNumber IS this code. */
  name: string;
  brand: string | null;
  description: string | null;
  upc: string | null;
  imageUrl: string | null;
  /** Amazon's own category path — a strong hint for the categorizer, never a
   *  marketplace category itself (Amazon's tree is not Mathis/Walmart's). */
  categoryHint: string | null;
  asin: string;
};

/** Digits/letters only, uppercased — compares a sheet code to a Keepa
 *  partNumber without tripping on punctuation or case. */
function partKey(s: string): string {
  return s.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * The vendor prefix of a sheet code: everything before the first "-"
 * ("VIDA-134804" → "VIDA"). Used to look the brand up once per vendor rather
 * than per product.
 */
export function skuVendorPrefix(sku: string | null | undefined): string | null {
  const s = (sku ?? "").trim();
  if (!s.includes("-")) return null;
  const prefix = s.split("-")[0]!.trim();
  return prefix.length >= 2 ? prefix : null;
}

/**
 * The bare item number a manufacturer would print on the box: the sheet code
 * minus its vendor prefix ("VIDA-134804" → "134804"). Keepa's partNumber holds
 * this form, never the reseller's prefixed one.
 */
export function skuItemNumber(sku: string | null | undefined): string | null {
  const s = (sku ?? "").trim();
  if (!s) return null;
  const rest = s.includes("-") ? s.slice(s.indexOf("-") + 1).trim() : s;
  return rest.length >= 3 ? rest : null;
}

/** Main product image. Keepa serves an `images` array (l/m filenames, MAIN
 *  first) on current responses and the legacy `imagesCSV` on older ones —
 *  buildImages() in keepa/product.ts handles both for the same reason. */
function firstImage(p: KeepaProduct): string | null {
  const base = "https://m.media-amazon.com/images/I/";
  if (Array.isArray(p.images) && p.images.length) {
    // Keepa orders the MAIN variant first; hiRes → large → medium.
    const main = p.images[0];
    const file = main?.hiRes || main?.l || main?.m;
    if (file) return base + file;
  }
  const csv = typeof p.imagesCSV === "string" ? p.imagesCSV : "";
  const name = csv.split(",").map((s) => s.trim()).find(Boolean);
  return name ? base + name : null;
}

function firstBarcode(p: KeepaProduct): string | null {
  const lists = [p.upcList, p.eanList];
  for (const list of lists) {
    if (Array.isArray(list)) {
      const hit = list.map((c) => String(c).replace(/\D/g, "")).find((c) => c.length >= 8);
      if (hit) return hit;
    }
  }
  return null;
}

function categoryPath(p: KeepaProduct): string | null {
  const tree = p.categoryTree;
  if (!Array.isArray(tree) || !tree.length) return null;
  const names = tree.map((c) => (c?.name ?? "").trim()).filter(Boolean);
  return names.length ? names.join(" > ") : null;
}

/**
 * Resolve vendor item numbers to real products through Keepa, scoped to one
 * brand. Returns a Map keyed by `partKey(code)` — callers look up with the same
 * helper. Never throws: a Keepa failure (no key, out of tokens, API error)
 * degrades to "resolved nothing", exactly as if the lookup didn't exist.
 */
export async function resolveSkusViaKeepa(
  itemNumbers: string[],
  brand: string,
): Promise<Map<string, KeepaSkuMatch>> {
  const out = new Map<string, KeepaSkuMatch>();
  const b = brand.trim();
  // No brand, no lookup — see the note at the top of this file.
  if (!b) return out;

  const codes = [...new Set(itemNumbers.map((c) => c.trim()).filter((c) => c.length >= 3))];
  if (!codes.length) return out;

  try {
    for (let i = 0; i < codes.length; i += FINDER_BATCH) {
      const slice = codes.slice(i, i + FINDER_BATCH);
      // productType 0/1 = real, buyable listings (excludes variation parents,
      // ebooks and invalid entries, none of which are the physical item).
      const { asinList } = await finder(AMAZON_US, {
        partNumber: slice,
        brand: [b.toLowerCase()],
        productType: [0, 1],
        perPage: 100,
      });
      if (!asinList.length) continue;

      const products = await getProducts(AMAZON_US, asinList, { stats: 0 });
      for (const p of products) {
        const pn = typeof p.partNumber === "string" ? p.partNumber : "";
        const key = partKey(pn);
        // The finder matches on more than partNumber alone, so confirm THIS
        // product really carries the code we asked for before trusting it.
        if (!key || !slice.some((c) => partKey(c) === key)) continue;
        const title = typeof p.title === "string" ? p.title.trim() : "";
        if (!title) continue;
        // Several listings can share one partNumber (the same item relisted, or
        // a size/colour sibling). They are the same product for categorization
        // purposes; keep the first and stay deterministic.
        if (out.has(key)) continue;
        out.set(key, {
          name: title,
          brand: typeof p.brand === "string" ? p.brand : (typeof p.manufacturer === "string" ? p.manufacturer : null),
          description: typeof p.description === "string" ? p.description.slice(0, 1000) : null,
          upc: firstBarcode(p),
          imageUrl: firstImage(p),
          categoryHint: categoryPath(p),
          asin: p.asin,
        });
      }
    }
  } catch (e) {
    const why = e instanceof KeepaError ? `${e.message}` : String(e);
    console.warn(`[keepa-sku] lookup failed for brand "${b}" — continuing without it:`, why);
    return out;
  }
  return out;
}
