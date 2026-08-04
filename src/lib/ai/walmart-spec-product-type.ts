import { generateText } from "ai";
import { moonshot, moonshotConfigured } from "@/lib/ai/moonshot";

// Walmart's "Spec Product Type" is a required field on the new-listing template
// (e.g. "Bicycle Tires", "Dream Catcher"). The valid list is Walmart's Product
// Type taxonomy, fetched live from the Seller API — it is not embedded in the
// template. This module caches that list and assigns each product a product
// type from it via the AI model.

// In-process cache of the product-type NAMES. The taxonomy is large and
// changes rarely, so one fetch serves a whole categorize run (and beyond, until
// TTL). null = not yet loaded; [] = loaded but empty (API unavailable).
let cachedTypes: string[] | null = null;
let cachedAt = 0;
const TTL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * The valid Spec Product Type names, from the Walmart taxonomy API.
 * Returns [] (never throws) when the API/creds are unavailable, so the caller
 * degrades to leaving the field blank rather than failing the whole run.
 */
export async function loadSpecProductTypes(): Promise<string[]> {
  if (cachedTypes && Date.now() - cachedAt < TTL_MS) return cachedTypes;
  try {
    const { getItemTaxonomy, sellerApiConfigured } = await import("@/lib/walmart/seller-client");
    if (!sellerApiConfigured()) {
      cachedTypes = []; cachedAt = Date.now();
      return cachedTypes;
    }
    const taxonomy = await getItemTaxonomy();
    cachedTypes = [...new Set(taxonomy.map((t) => t.productType).filter(Boolean))];
    cachedAt = Date.now();
  } catch (e) {
    // Auth/network failure — don't cache a failure long; blank the field this run.
    console.error("[spec-product-type] taxonomy fetch failed:", e);
    cachedTypes = [];
    cachedAt = Date.now();
  }
  return cachedTypes;
}

export type SpecTypeInput = { id: string; name: string; brand?: string | null; description?: string | null; category?: string | null };

/**
 * Assign a valid Spec Product Type to each product. Returns a map productId →
 * product type. Products the model can't confidently place are omitted (the
 * export leaves the cell blank rather than writing an invalid value).
 *
 * A no-op returning an empty map when the taxonomy is unavailable or there's no
 * API key — so this can be called unconditionally and simply does nothing until
 * both are present.
 */
export async function assignSpecProductTypes(
  products: SpecTypeInput[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!products.length || !moonshotConfigured()) return result;

  const types = await loadSpecProductTypes();
  if (!types.length) return result; // taxonomy unavailable → leave blank

  const allowed = new Set(types);
  // The full taxonomy list goes into every batch prompt, so the auto-tier model
  // (up to 128k) keeps large taxonomies from overflowing context.
  const model = process.env.CATEGORIZE_MODEL ?? "moonshot-v1-auto";

  // The full taxonomy can be very large. Send it once per batch; keep batches
  // small so the list + products fit comfortably in context.
  const typeList = types.map((t) => `- ${t}`).join("\n");
  const BATCH = 15;
  const CONCURRENCY = 3;

  const batches: SpecTypeInput[][] = [];
  for (let i = 0; i < products.length; i += BATCH) batches.push(products.slice(i, i + BATCH));

  const runBatch = async (batch: SpecTypeInput[]): Promise<void> => {
    const list = batch.map((p, idx) => {
      let line = `${idx + 1}. "${p.name}"`;
      if (p.brand) line += ` by ${p.brand}`;
      if (p.category) line += ` [category: ${p.category}]`;
      if (p.description) line += ` — ${p.description.slice(0, 150)}`;
      return line;
    }).join("\n");

    try {
      const { text } = await generateText({
        model: moonshot(model),
        prompt: `You are a Walmart listing expert. Assign each product the single best "Spec Product Type" from Walmart's official list below. Copy the value character-for-character. If none fits, use "" (empty).

Valid Spec Product Types:
${typeList}

Products:
${list}

Respond ONLY with a JSON array, no markdown:
[{"index":1,"productType":"<exact value or empty>"},...]`,
        maxOutputTokens: 1500,
        temperature: 0.2,
      });

      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return;
      const parsed = JSON.parse(match[0]) as { index: number; productType: string }[];
      for (const r of parsed) {
        const p = batch[r.index - 1];
        const pt = (r.productType ?? "").trim();
        // Only accept a value that's actually on the list — never write an
        // invented type that Walmart would reject on import.
        if (p && pt && allowed.has(pt)) result.set(p.id, pt);
      }
    } catch (e) {
      console.error("[spec-product-type] batch failed:", e);
      // Leave this batch's products without a product type.
    }
  };

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    await Promise.all(batches.slice(i, i + CONCURRENCY).map(runBatch));
  }

  return result;
}
