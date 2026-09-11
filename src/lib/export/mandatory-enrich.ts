/**
 * Real catalog data for the mandatory cells no vendor sheet carries.
 *
 * A Mathis template marks UPC and the DIMH/DIMW/DIMD/weight block REQUIRED, and
 * a thin vendor upload has none of them — one real file carried 6 to 18 columns
 * per product, with no barcode and no measurement anywhere. Those cells cannot
 * be written by a language model: a fabricated barcode attaches the listing to
 * somebody else's product, and invented measurements ship to the storefront as
 * fact. They have to be looked up.
 *
 * Mathis has no listing API, which is why its projects skip Verify — but Keepa
 * and Synccentric are product-data APIs keyed on part number and barcode, not on
 * a marketplace, so they answer for Mathis rows just as well:
 *
 *   vendor SKU → MPN ──Synccentric──▶ real UPC + brand + title
 *                            UPC ──Keepa──▶ real package dimensions and weight
 *
 * Measured on the client's own file, 6 of 6 part numbers resolved to genuine
 * barcodes (Modway EEI-6769-BAS → 889654288954, Benjara BM300217 →
 * 192551947429).
 *
 * Safety comes from Synccentric's own brand filter. Part numbers repeat across
 * manufacturers, so a lookup without a brand returns other companies' products —
 * that is how "Painting Knives" once overwrote a vidaXL row. The brand is
 * therefore GUESSED here and VALIDATED there: a wrong guess matches nothing and
 * the row is left alone, which is the safe failure.
 */
import { generateText } from "ai";
import { moonshot, moonshotConfigured, MOONSHOT_TEXT_MODEL, noThinkingHeaders, noThinkingTemperature } from "@/lib/ai/moonshot";
import { searchByPartNumber, synccentricConfigured } from "@/lib/synccentric/client";
import { getProductsByCode } from "@/lib/keepa/client";
import { normalizeProduct } from "@/lib/keepa/product";

export type MandatoryFacts = {
  upc?: string;
  brand?: string;
  /** Inches, as the Mathis dimension columns expect. */
  widthIn?: number;
  heightIn?: number;
  depthIn?: number;
  /** Pounds. */
  weightLb?: number;
  /** Real catalog images, largest first. The SILO (white-background) image is
   *  the template's first required image column. */
  images?: string[];
};

export type EnrichInput = {
  id: string;
  name: string | null;
  brand: string | null;
  vendorSku: string | null;
  upc: string | null;
};

const MM_PER_INCH = 25.4;
const G_PER_LB = 453.59237;

/**
 * The manufacturer part number inside a vendor SKU.
 *
 * Vendor sheets prefix their own code and flatten the manufacturer's
 * punctuation: Modway's EEI-6769-BAS arrives as "MODA-EEI6769BAS". Synccentric
 * matches the manufacturer's number in its OWN format — "EEI-6769-BAS" resolves
 * while "EEI6769BAS" does not — so the dashes have to be put back. Segmenting at
 * letter/digit boundaries reconstructs them.
 *
 * All spellings are offered together: the endpoint answers 404 when NOTHING in
 * a batch matches, so a batch that contains the right spelling succeeds for
 * every code in it.
 */
export function partNumberCandidates(vendorSku: string): string[] {
  const raw = vendorSku.trim();
  if (!raw) return [];
  const out = new Set<string>([raw]);
  const dash = raw.indexOf("-");
  const bare = dash > 1 && dash <= 5 ? raw.slice(dash + 1) : raw;
  out.add(bare);
  // "EEI6769BAS" → "EEI-6769-BAS"; a code already punctuated is unchanged.
  const segmented = bare.replace(/([A-Za-z])(\d)/g, "$1-$2").replace(/(\d)([A-Za-z])/g, "$1-$2");
  out.add(segmented);
  // Finish/colour suffixes are themselves two codes run together: Modway's
  // EEI-6954-WHI-RUS flattens to "…WHIRUS". A trailing letter run of exactly
  // six splits down the middle, which recovered all three misses on the
  // client's file (WHIRUS, GLDWHI, BLKPRL).
  const tail = /-([A-Za-z]{6})$/.exec(segmented);
  if (tail) {
    out.add(segmented.replace(/-([A-Za-z]{3})([A-Za-z]{3})$/, "-$1-$2"));
  }
  return [...out].filter((c) => c.length >= 3);
}

/**
 * Brand candidates for a row, best first. Only ever used as a lookup filter that
 * the data source itself validates, so a wrong guess costs a miss, not a wrong
 * value.
 */
export function brandCandidates(p: EnrichInput): string[] {
  const out: string[] = [];
  if (p.brand?.trim()) out.push(p.brand.trim());
  // Titles very often name the maker outright: "… Counter Stool by Modway".
  const by = /\bby\s+([A-Z][A-Za-z0-9&.' ]{2,24})$/.exec(String(p.name ?? "").trim());
  if (by?.[1]) out.push(by[1].trim());
  return [...new Set(out.map((b) => b.trim()).filter(Boolean))];
}

/** mm → inches, rounded to the hundredth the templates use. */
const mmToIn = (mm: number | null | undefined): number | undefined =>
  typeof mm === "number" && mm > 0 ? Math.round((mm / MM_PER_INCH) * 100) / 100 : undefined;

/**
 * Look up real UPCs, brands, dimensions and weights for the given products.
 *
 * `brandHints` maps productId → brand for rows whose brand had to be inferred
 * elsewhere (e.g. from a vendor-code prefix). Never throws: a source that fails
 * contributes nothing and the rest still resolve.
 */
export async function enrichMandatoryFacts(
  products: EnrichInput[],
  brandHints?: Map<string, string>,
): Promise<Map<string, MandatoryFacts>> {
  const out = new Map<string, MandatoryFacts>();
  if (!products.length) return out;

  // ── 1. Part number + brand → UPC, via Synccentric ──────────────────────────
  // Grouped by brand because the endpoint filters on one brand per call.
  if (synccentricConfigured()) {
    const byBrand = new Map<string, Array<{ id: string; codes: string[] }>>();
    for (const p of products) {
      if (!p.vendorSku) continue;
      const codes = partNumberCandidates(p.vendorSku);
      if (!codes.length) continue;
      const brands = brandCandidates(p);
      const hinted = brandHints?.get(p.id);
      if (hinted) brands.push(hinted);
      for (const b of new Set(brands)) {
        const key = b.toLowerCase();
        byBrand.set(key, [...(byBrand.get(key) ?? []), { id: p.id, codes }]);
      }
    }

    const norm = (s: string) => s.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    for (const [brandKey, rows] of byBrand) {
      const codes = [...new Set(rows.flatMap((r) => r.codes))];
      if (!codes.length) continue;
      try {
        const found = await searchByPartNumber(codes, brandKey);
        if (!found.size) continue;
        for (const row of rows) {
          if (out.get(row.id)?.upc) continue; // an earlier brand already answered
          for (const code of row.codes) {
            const hit = found.get(norm(code));
            if (!hit) continue;
            const facts: MandatoryFacts = { ...(out.get(row.id) ?? {}) };
            const upc = hit.upcList?.[0];
            if (upc) facts.upc = String(upc);
            if (hit.brand) facts.brand = hit.brand;
            out.set(row.id, facts);
            break;
          }
        }
      } catch (e) {
        console.warn(
          `[mandatory-enrich] synccentric lookup for "${brandKey}" failed:`,
          (e as Error).message,
        );
      }
    }
  }

  // ── 2. UPC → package dimensions and weight, via Keepa ──────────────────────
  // Uses the barcode the row already had, or the one step 1 just found.
  const codeToIds = new Map<string, string[]>();
  for (const p of products) {
    const upc = out.get(p.id)?.upc ?? String(p.upc ?? "").trim();
    if (!/^\d{8,14}$/.test(upc)) continue;
    codeToIds.set(upc, [...(codeToIds.get(upc) ?? []), p.id]);
  }
  if (codeToIds.size && process.env.KEEPA_API_KEY) {
    try {
      const { products: keepaProducts } = await getProductsByCode(1, [...codeToIds.keys()]);
      for (const kp of keepaProducts) {
        const n = normalizeProduct(kp, 1);
        const ids = (kp.upcList ?? []).flatMap((c) => codeToIds.get(String(c)) ?? []);
        for (const id of ids) {
          const facts: MandatoryFacts = { ...(out.get(id) ?? {}) };
          // Keepa reports the PACKAGE box as length/width/height, unlabelled by
          // orientation; mapped onto depth/width/height, how a box is quoted.
          facts.depthIn ??= mmToIn(n.lengthMm);
          facts.widthIn ??= mmToIn(n.widthMm);
          facts.heightIn ??= mmToIn(n.heightMm);
          if (typeof n.weightG === "number" && n.weightG > 0) {
            facts.weightLb ??= Math.round((n.weightG / G_PER_LB) * 100) / 100;
          }
          if (!facts.brand && n.brand) facts.brand = n.brand;
          if (!facts.images?.length && n.images?.length) facts.images = n.images.slice(0, 10);
          out.set(id, facts);
        }
      }
    } catch (e) {
      console.warn("[mandatory-enrich] keepa dimension lookup failed:", (e as Error).message);
    }
  }

  return out;
}

/**
 * The manufacturer behind each vendor-SKU prefix, e.g. MODA → Modway,
 * BNZR → Benzara.
 *
 * A lookup by part number needs a brand to filter on, and vendor sheets rarely
 * carry one — the client's file has `brand` null on every row. The prefix does
 * encode it, but only a human (or a model) reads "BNZR" as Benzara, so the
 * model is asked once per distinct prefix with a few of that prefix's titles
 * for context.
 *
 * A guess is never written anywhere: it is only offered to Synccentric, whose
 * own brand filter rejects it if wrong. So the cost of a bad guess is a missed
 * lookup, not bad data.
 */
export async function inferBrandsForPrefixes(
  products: EnrichInput[],
): Promise<Map<string, string>> {
  const hints = new Map<string, string>();
  const byPrefix = new Map<string, EnrichInput[]>();
  for (const p of products) {
    if (p.brand?.trim()) continue; // already known
    const sku = String(p.vendorSku ?? "");
    const dash = sku.indexOf("-");
    if (dash < 2 || dash > 5) continue;
    const prefix = sku.slice(0, dash).toUpperCase();
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), p]);
  }
  if (!byPrefix.size || !moonshotConfigured()) return hints;

  const items = [...byPrefix].map(([prefix, rows], i) => {
    const titles = rows.slice(0, 3).map((r) => `      - ${String(r.name ?? "").slice(0, 90)}`).join("\n");
    return `${i + 1}. vendor code: "${prefix}"
   products sold under it:
${titles}`;
  }).join("\n\n");

  try {
    const { text } = await generateText({
      model: moonshot(MOONSHOT_TEXT_MODEL),
      temperature: noThinkingTemperature(MOONSHOT_TEXT_MODEL, 0),
      headers: noThinkingHeaders(MOONSHOT_TEXT_MODEL),
      maxOutputTokens: Math.max(500, byPrefix.size * 40),
      prompt: `Each item is a short vendor code that stands for a furniture or homeware MANUFACTURER, with a few product titles sold under it.

Name the manufacturer each code abbreviates.

Rules:
- Answer with the manufacturer's name only ("Modway", "Benzara"), nothing else.
- The code is usually an abbreviation of the name: MODA → Modway, BNZR → Benzara.
- If you cannot tell, output an empty string. A wrong name is worse than none.

Items:

${items}

Respond with one line per item, in order, formatted exactly as:
<item number>: <manufacturer or empty>
No other text.`,
    });

    const prefixes = [...byPrefix.keys()];
    for (const line of text.replace(/[*_`#]/g, "").split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s*:\s*(.*)$/);
      if (!m) continue;
      const prefix = prefixes[parseInt(m[1], 10) - 1];
      const brand = m[2].trim().replace(/^["']|["']$/g, "");
      if (!prefix || !brand || brand.length < 3) continue;
      for (const p of byPrefix.get(prefix) ?? []) hints.set(p.id, brand);
    }
  } catch (e) {
    console.warn("[mandatory-enrich] brand inference failed:", (e as Error).message);
  }
  return hints;
}
