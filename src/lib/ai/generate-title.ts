import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { Product } from "@prisma/client";

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Haiku: fast, low-memory, handles title generation well at this batch size.
// Override via TITLE_ANTHROPIC_MODEL env var if a stronger model is needed.
const TITLE_MODEL = process.env.TITLE_ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001";

const TITLE_RULES: Record<string, { maxLen: number; guidance: string }> = {
  walmart: {
    maxLen: 75,
    guidance: `Walmart title rules:
- Structure: [Brand] [Defining Attribute(s)] [Product Type] [Key Feature/USP], [Color/Size/Pack]
- Lead with the brand when known, then the single most important buying attribute.
- Surface the product's main USP (what makes a shopper choose it: "Memory Foam", "Waterproof", "Solid Wood", "Set of 4", "Cordless").
- Include the most searchable specifics: material, color, size, pack/count, capacity.
- Consumer-friendly language only — expand vendor abbreviations, drop internal codes/SKUs.
- Title Case. No ALL CAPS, no "!!!", no promo words (Best, #1, Sale, Cheap).`,
  },
  amazon: {
    maxLen: 200,
    guidance: `Amazon title rules:
- Structure: [Brand] [Product] [Key Feature] [Material/Color] [Size/Pack]
- Include primary keywords naturally; front-load the most important ones.
- No promotional language (Best, #1, Amazing, Free Shipping).`,
  },
  temu: {
    maxLen: 60,
    guidance: `Temu title rules:
- Descriptive and feature-rich within the length limit.
- Include style, material, color, size/count.
- Appeal to value-conscious buyers.`,
  },
};

// Case-insensitive attribute miner. Real vendor sheets use arbitrary casing/spacing
// ("Color", "Colour", "Material Type", "PACK QTY"), so we normalize keys before
// matching. Without this the AI receives no real attributes and titles stay generic.
const ATTR_ALIASES: Record<string, string[]> = {
  color: ["color", "colour", "colorname", "primarycolor", "finish", "finishcolor"],
  material: ["material", "materials", "materialtype", "fabric", "fabrictype", "composition"],
  size: ["size", "itemsize", "dimensions", "productsize"],
  style: ["style", "designstyle", "collection", "series"],
  pack: ["pack", "packsize", "packcount", "count", "quantityperset", "piecesperpack", "numberofpieces", "pieces"],
  capacity: ["capacity", "volume", "storage"],
  feature: ["feature", "keyfeature", "features", "keyfeatures", "highlights", "usp"],
};

const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function mineAttributes(vd: Record<string, unknown> | null): string {
  if (!vd) return "";
  // Build a normalized-key → value view of the vendor row once.
  const norm = new Map<string, string>();
  for (const [k, v] of Object.entries(vd)) {
    if (v == null || v === "") continue;
    const val = String(v).trim();
    if (val) norm.set(normKey(k), val);
  }
  const parts: string[] = [];
  for (const [label, aliases] of Object.entries(ATTR_ALIASES)) {
    for (const a of aliases) {
      const hit = norm.get(a);
      if (hit) { parts.push(`${label}: ${hit}`); break; }
    }
  }
  return parts.join(", ");
}

export async function generateMarketplaceTitles(
  marketplace: string,
  products: Product[],
): Promise<Map<string, string>> {
  const titleMap = new Map<string, string>();
  if (!products.length) return titleMap;

  const cfg = TITLE_RULES[marketplace.toLowerCase()] ?? TITLE_RULES.walmart;
  const BATCH = Number(process.env.TITLE_BATCH_SIZE ?? 15);
  // Batches were previously awaited one at a time, so a 500-product export made
  // ~34 serial model calls (several minutes) before ZIP generation could even
  // start — the single biggest cause of export timeouts. The batches are fully
  // independent, so run several in flight at once. Raised 6 → 10 so several-
  // thousand-product Walmart exports finish title generation well inside the
  // request budget; tunable via env for larger runs.
  const CONCURRENCY = Number(process.env.TITLE_CONCURRENCY ?? 10);

  // Precompute every batch's payload, then run them in bounded-concurrency waves.
  const batches: Product[][] = [];
  for (let i = 0; i < products.length; i += BATCH) {
    batches.push(products.slice(i, i + BATCH));
  }

  const runBatch = async (batch: Product[], batchIndex: number): Promise<void> => {
    const input = batch.map((p) => {
      const vd = (p.vendorData as Record<string, unknown> | null) ?? null;
      return {
        id: p.id,
        vendor_title: p.name,
        brand: p.brand ?? "",
        category: p.marketplaceCategory ?? "",
        description: (p.description ?? "").slice(0, 300),
        attributes: mineAttributes(vd),
      };
    });

    try {
      const { text } = await generateText({
        model: anthropic(TITLE_MODEL),
        prompt: `You are an expert ${marketplace} e-commerce copywriter. Write a NEW, optimised product title for each product below.

${cfg.guidance}

Method for each product:
1. Read the vendor_title, brand, category, description and attributes to understand what the product actually IS.
2. Identify its key attributes and its main unique selling point (USP) — the reason a shopper would pick it.
3. Compose a fresh title that conveys the product's meaning and USP. Do NOT copy the vendor_title word-for-word or merely reorder it — write it as a shopper would search for it.
4. Keep every title at or under ${cfg.maxLen} characters. If needed, drop the least important detail to fit.
5. Never invent attributes that aren't supported by the input. If information is thin, describe accurately rather than guessing.

Return ONLY a JSON array — no explanation, no markdown, no code fences.
Format: [{"id":"<id>","title":"<title>"}]

Products:
${JSON.stringify(input, null, 2)}`,
        maxOutputTokens: 2000,
      });

      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as { id: string; title: string }[];
        for (const item of parsed) {
          if (item.id && typeof item.title === "string" && item.title.trim()) {
            // Hard cap length as a safety net in case the model overruns.
            let title = item.title.trim().replace(/\s+/g, " ");
            if (title.length > cfg.maxLen) {
              title = title.slice(0, cfg.maxLen).replace(/[\s,;:-]+\S*$/, "").trim() || title.slice(0, cfg.maxLen).trim();
            }
            titleMap.set(item.id, title);
          }
        }
      }
    } catch (err) {
      const start = batchIndex * BATCH;
      console.error(`[generate-title] batch ${start}–${start + batch.length} failed:`, err);
      // Fall through — products that fail keep their original vendor name.
    }
  };

  // Bounded-concurrency waves. Failures are already swallowed per batch, so one
  // bad batch never takes down the rest of the export.
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const wave = batches.slice(i, i + CONCURRENCY);
    await Promise.all(wave.map((b, j) => runBatch(b, i + j)));
    // Yield between waves so the event loop stays responsive to status polls.
    await new Promise<void>((r) => setImmediate(r));
  }

  return titleMap;
}
