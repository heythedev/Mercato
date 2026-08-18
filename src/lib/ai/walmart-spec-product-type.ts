import { generateText } from "ai";
import { moonshot, moonshotConfigured, moonshotTemperature } from "@/lib/ai/moonshot";
import { loadWalmartProductTypes, productTypesForCategoryPath } from "@/lib/ai/walmart-taxonomy";

// Walmart's "Spec Product Type" is a required field on the new-listing template
// (e.g. "Bicycle Tires", "Dream Catcher"). The valid list is Walmart's Product
// Type taxonomy — it is not embedded in the template. This module resolves that
// list (local walmart_taxonomy_raw.json first, live Seller API as fallback) and
// assigns each product a product type from it via the AI model.

// In-process cache of the product-type NAMES from the live API fallback. The
// taxonomy is large and changes rarely, so one fetch serves a whole categorize
// run (and beyond, until TTL). null = not yet loaded; [] = loaded but empty
// (API unavailable). The local-JSON path has its own mtime cache and skips this.
let cachedTypes: string[] | null = null;
let cachedAt = 0;
const TTL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * The valid Spec Product Type names. Preferred source is the local raw taxonomy
 * JSON (walmart_taxonomy_raw.json — ~7K types, no credentials or network
 * needed); the live Seller API taxonomy is the fallback when the file is absent.
 * Returns [] (never throws) when neither is available, so the caller degrades
 * to leaving the field blank rather than failing the whole run.
 */
export async function loadSpecProductTypes(): Promise<string[]> {
  // Local file first — deterministic, credential-free, hot-swappable.
  const local = loadWalmartProductTypes();
  if (local?.length) return local;

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
  // The taxonomy list can be very large, so the auto-tier model (up to 128k)
  // keeps big prompts from overflowing context.
  const model = process.env.CATEGORIZE_MODEL ?? "moonshot-v1-auto";

  const BATCH = 15;
  const CONCURRENCY = 3;

  // Scope the prompt's type list per product where possible: a product whose
  // assigned category resolves in the raw taxonomy ("Home > Table Lamps") only
  // needs its category's slice of the ~7K-entry list — a far smaller prompt and
  // a far harder-to-miss target. Products without a resolvable category are
  // batched separately against the full list (the pre-JSON behaviour).
  const fullTypeList = types.map((t) => `- ${t}`).join("\n");
  const byScope = new Map<string, { list: string; items: SpecTypeInput[] }>();
  for (const p of products) {
    const scoped = p.category ? productTypesForCategoryPath(p.category) : null;
    const key = scoped ? p.category!.trim() : "";
    if (!byScope.has(key)) {
      byScope.set(key, {
        list: scoped ? scoped.map((t) => `- ${t}`).join("\n") : fullTypeList,
        items: [],
      });
    }
    byScope.get(key)!.items.push(p);
  }

  const batches: { typeList: string; batch: SpecTypeInput[] }[] = [];
  for (const { list, items } of byScope.values()) {
    for (let i = 0; i < items.length; i += BATCH) {
      batches.push({ typeList: list, batch: items.slice(i, i + BATCH) });
    }
  }

  const runBatch = async ({ typeList, batch }: { typeList: string; batch: SpecTypeInput[] }): Promise<void> => {
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
        prompt: `You are a Walmart listing expert. Assign each product the single best "Spec Product Type" from Walmart's official list below.

Rules:
1. Decide from the product NAME (plus brand/description) — what the item physically IS. The [category] tag only tells you which slice of the taxonomy you are in; it is NOT the answer and must not be echoed back as the product type.
2. Pick the most SPECIFIC type that matches the product — never a broad catch-all (anything like "Other", "All X" or a generic parent term) when a narrower listed type plainly fits.
3. Copy the chosen value character-for-character from the list. Never invent, abbreviate, or paraphrase a type.
4. Use "" (empty) ONLY when genuinely no listed type describes the item — not because the name is short or the category tag is vague.

Valid Spec Product Types:
${typeList}

Products:
${list}

Respond ONLY with a JSON array, no markdown:
[{"index":1,"productType":"<exact value or empty>"},...]`,
        maxOutputTokens: 1500,
        temperature: moonshotTemperature(model, 0.2),
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
