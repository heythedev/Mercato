import { generateText } from "ai";
import { moonshot, moonshotConfigured, MOONSHOT_TEXT_MODEL, moonshotTemperature } from "@/lib/ai/moonshot";

/**
 * AI fallback for template dropdown (dataValidation) columns.
 *
 * Marketplace templates constrain many columns to a fixed option list. A value that is
 * not character-for-character one of those options makes the cell invalid on import —
 * the marketplace rejects the row. Deterministic matching (exact → word overlap →
 * substring, see pickDropdownValue in lib/export/zip.ts) resolves most values, but
 * vendor wording often has no lexical overlap with the option list at all:
 *
 *   "Charcoal"        → options [Black, Grey, Brown, White]        → Grey
 *   "Boucle"          → options [Fabric, Leather, Wood, Metal]     → Fabric
 *   "Queen Size Bed"  → options [Twin, Full, Queen, King]          → Queen
 *
 * Those need semantic judgement, so unresolved values are batched here and matched by
 * the model against the exact option list. The model may only return an option verbatim
 * or the empty string; anything else is discarded by the caller. Failures are non-fatal —
 * the caller keeps its deterministic result — so an export never breaks on AI errors.
 */

// Constrained option matching is a simple task; override via DROPDOWN_MODEL if needed.
const MODEL = process.env.DROPDOWN_MODEL ?? MOONSHOT_TEXT_MODEL;

/** Skip AI for option lists too large to fit sensibly in a prompt (e.g. full taxonomies). */
const MAX_OPTIONS = 300;
/** Unresolved values matched per request. */
const BATCH_SIZE = 40;
/** Attempts per batch before its values are left blank. */
const MAX_ATTEMPTS = 3;
/** Batches in flight at once — keeps large exports inside their time limit. */
const CONCURRENCY = 4;

/**
 * Cache key for one (column, value) pair. Callers MUST build lookup keys with this
 * function rather than interpolating by hand, so the producer and consumer of the
 * result map can never disagree on the separator.
 */
export function dropdownKey(column: string, value: string): string {
  return `${column}\u0000${value}`;
}

export type DropdownQuery = {
  /** Template column header, gives the model context ("Color", "Material"). */
  column: string;
  /** The vendor value that failed deterministic matching. */
  value: string;
  /** The column's allowed options, verbatim from the template. */
  options: string[];
};

/**
 * Resolve each query to one of its own `options`, or to "" when nothing is compatible.
 * Keys are built by dropdownKey() — always use it to read the map.
 * Never throws: on any failure the map simply lacks that entry.
 */
export async function matchDropdownValues(
  queries: DropdownQuery[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!queries.length) return out;
  if (!moonshotConfigured()) {
    // Without a key every unmatched value blanks out, which looks like data loss in the
    // exported sheet. Say so loudly — this is a misconfiguration, not a normal outcome.
    console.error(
      `[match-dropdown] MOONSHOT_KEY is not set — ${queries.length} dropdown value(s) ` +
      `cannot be matched and will be left blank in the export.`,
    );
    return out;
  }

  // Deduplicate: the same (column, value, options) repeats across every product row.
  const unique = new Map<string, DropdownQuery>();
  for (const q of queries) {
    if (!q.value.trim() || !q.options.length || q.options.length > MAX_OPTIONS) continue;
    const key = dropdownKey(q.column, q.value);
    if (!unique.has(key)) unique.set(key, q);
  }
  if (!unique.size) return out;

  const entries = [...unique.entries()];
  const batches: [string, DropdownQuery][][] = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    batches.push(entries.slice(i, i + BATCH_SIZE));
  }

  // A real template has dozens of dropdown columns, so batches are run with bounded
  // concurrency — sequential requests would push a large export past its time limit.
  const runBatch = async (batch: [string, DropdownQuery][]): Promise<void> => {
    // A dropped batch means every value in it blanks out in the sheet, so a transient
    // API error (rate limit, timeout) is worth retrying before giving up on it.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const items = batch.map(([, q], n) => {
          const opts = q.options.map((o) => `    - ${o}`).join("\n");
          return `${n + 1}. column: "${q.column}"\n   vendor value: "${q.value}"\n   allowed options:\n${opts}`;
        }).join("\n\n");

        const { text } = await generateText({
          model: moonshot(MODEL),
          temperature: moonshotTemperature(MODEL, 0),
          prompt: `You map vendor product values onto a marketplace template's fixed dropdown options.

For each item choose the single allowed option that is the nearest compatible match for the vendor value.

Rules:
- Copy the chosen option EXACTLY as written in its list (same spelling, casing, spacing, punctuation).
- Choose from that item's OWN option list only — never an option from another item.
- Judge by meaning, not spelling: "Charcoal" → "Grey", "Boucle" → "Fabric", "Queen Size Bed" → "Queen".
- If no option is a reasonable match, output an empty string after the colon. Never invent a value and never guess wildly.

Items:

${items}

Respond with one line per item, in order, formatted exactly as:
<item number>: <chosen option or empty>
No other text.`,
        });

        // Strip markdown ("**1:** Grey") the kimi models add despite "No other text".
        for (const line of text.replace(/[*_`#]/g, "").split(/\r?\n/)) {
          const m = line.match(/^\s*(\d+)\s*:\s*(.*)$/);
          if (!m) continue;
          const idx = parseInt(m[1], 10) - 1;
          const picked = m[2].trim().replace(/^["']|["']$/g, "");
          const entry = batch[idx];
          if (!entry) continue;
          const [key, q] = entry;
          if (!picked) continue;
          // Only accept a verbatim option (case-insensitive compare, canonical casing stored).
          const exact = q.options.find((o) => o.toLowerCase() === picked.toLowerCase());
          if (exact) out.set(key, exact);
        }
        return; // batch succeeded
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        // Exhausted retries — the caller blanks these cells rather than writing bad data.
        console.warn(
          `[match-dropdown] giving up on a batch of ${batch.length} value(s) after ` +
          `${MAX_ATTEMPTS} attempts; they will be left blank:`, err,
        );
      }
    }
  };

  // Simple worker pool: CONCURRENCY batches in flight at a time.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        if (batch) await runBatch(batch);
      }
    }),
  );

  return out;
}

// ── Mandatory-cell fill (no vendor value at all) ──────────────────────────────

export type DropdownFillQuery = {
  /** Caller's correlation key (e.g. productId + column letter). */
  key: string;
  /** Template column header ("STYLE", "Assembly Required"). */
  column: string;
  /** Product identity: name, brand, description — what a human operator would read. */
  context: string;
  /** The column's allowed options, verbatim from the template. */
  options: string[];
};

/**
 * Choose a dropdown option for a product that has NO vendor value at all.
 *
 * matchDropdownValues above maps an EXISTING vendor value onto the list; this
 * fills a mandatory cell the vendor left empty. For a dropdown column the true
 * answer is by definition one of the client's own allowed options, so this is
 * the same judgment call a human operator makes when completing the sheet
 * ("STYLE: Contemporary" for a modern vase). The model may only answer with an
 * option verbatim or an empty string (context genuinely uninformative);
 * anything else is discarded. Never throws — missing entries simply stay empty
 * and flow into the compliance report.
 */
export async function fillDropdownValues(
  queries: DropdownFillQuery[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!queries.length) return out;
  if (!moonshotConfigured()) {
    console.error(
      `[match-dropdown] MOONSHOT_KEY is not set — ${queries.length} mandatory dropdown ` +
        `cell(s) cannot be filled and will land in the compliance report.`,
    );
    return out;
  }

  // Deduplicate identical (column, context, options) asks; fan the answer back
  // out to every caller key that asked the same question.
  const usable = queries.filter(
    (q) => q.context.trim() && q.options.length && q.options.length <= MAX_OPTIONS,
  );
  const byAsk = new Map<string, { q: DropdownFillQuery; keys: string[] }>();
  for (const q of usable) {
    const askKey = `${q.column} ${q.context} ${q.options.join("")}`;
    const cur = byAsk.get(askKey);
    if (cur) cur.keys.push(q.key);
    else byAsk.set(askKey, { q, keys: [q.key] });
  }
  if (!byAsk.size) return out;

  const asks = [...byAsk.values()];
  const batches: (typeof asks)[] = [];
  for (let i = 0; i < asks.length; i += BATCH_SIZE) batches.push(asks.slice(i, i + BATCH_SIZE));

  const runBatch = async (batch: typeof asks): Promise<void> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const items = batch
          .map(({ q }, n) => {
            const opts = q.options.map((o) => `    - ${o}`).join("\n");
            return `${n + 1}. column: "${q.column}"\n   product: ${q.context}\n   allowed options:\n${opts}`;
          })
          .join("\n\n");

        const { text } = await generateText({
          model: moonshot(MODEL),
          temperature: moonshotTemperature(MODEL, 0),
          prompt: `You complete REQUIRED product-attribute dropdowns on a marketplace listing sheet. The vendor supplied no value, so choose from the product information the way a human operator would.

For each item choose the single allowed option that best describes the product.

Rules:
- Copy the chosen option EXACTLY as written in its list (same spelling, casing, spacing, punctuation).
- Choose from that item's OWN option list only — never an option from another item.
- Commit to the best-fitting option; when several fit, pick the most typical for this kind of product.
- Output an empty string after the colon ONLY when the product information says nothing usable for the column at all.

Items:

${items}

Respond with one line per item, in order, formatted exactly as:
<item number>: <chosen option or empty>
No other text.`,
        });

        // Strip markdown ("**1:** Casual") the kimi models add despite "No other text".
        for (const line of text.replace(/[*_`#]/g, "").split(/\r?\n/)) {
          const m = line.match(/^\s*(\d+)\s*:\s*(.*)$/);
          if (!m) continue;
          const idx = parseInt(m[1], 10) - 1;
          const picked = m[2].trim().replace(/^["']|["']$/g, "");
          const ask = batch[idx];
          if (!ask || !picked) continue;
          // Only accept a verbatim option (case-insensitive compare, canonical casing stored).
          const exact = ask.q.options.find((o) => o.toLowerCase() === picked.toLowerCase());
          if (exact) for (const key of ask.keys) out.set(key, exact);
        }
        return;
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        console.warn(
          `[match-dropdown] giving up on a mandatory-fill batch of ${batch.length} after ` +
            `${MAX_ATTEMPTS} attempts; those cells go to the compliance report:`, err,
        );
      }
    }
  };

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        if (batch) await runBatch(batch);
      }
    }),
  );

  return out;
}
