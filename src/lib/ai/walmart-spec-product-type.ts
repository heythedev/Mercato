import { generateText } from "ai";
import {
  moonshot,
  moonshotConfigured,
  moonshotTemperature,
  MOONSHOT_TEXT_MODEL,
  AiUnavailableError,
  classifyAiError,
  getAiOutage,
} from "@/lib/ai/moonshot";
import { loadWalmartApprovedMap, loadWalmartProductTypes, productTypesForCategoryPath } from "@/lib/ai/walmart-taxonomy";

// Walmart's "Spec Product Type" is the taxonomy's LEVEL 3 — the real product
// type ("Bicycle Tires", "Table Lamps") under "Category > Product Type Group".
// It is required on the templates and is what the approved-category mapping
// keys off, so every product must end a categorize run with one. This module
// assigns it: deterministic name-match first, then the AI model constrained to
// the assigned path's own slice of the ~7K-type list, validated against that
// slice, resumable across invocations (the caller skips already-current
// values), and deadline-aware so a time-budget stop loses nothing.

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
  if (local?.length) {
    // The client's approved mapping is upload-authoritative: a product type the
    // approved sheet doesn't carry has no approved category and gets the sheet
    // rejected, so assignment must never pick one (the raw taxonomy holds ~1.7k
    // such types). Filter to the intersection when the approved file exists.
    const approved = loadWalmartApprovedMap();
    if (approved) {
      const filtered = local.filter((t) => approved.byType.has(t.trim().toLowerCase()));
      if (filtered.length) return filtered;
    }
    return local;
  }

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

// ── Normalization / validation helpers ────────────────────────────────────────

/** Punctuation/case-insensitive, plural-tolerant key for a product type, so a
 *  near-miss model answer ("table lamp" for "Table Lamps") still canonicalizes
 *  onto the listed value instead of blanking. */
export function normSpecType(t: string): string {
  return t
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/s\b/g, "");
}

/**
 * An already-persisted spec type is CURRENT when it is on the valid list AND
 * consistent with the product's assigned path: either the path resolves no
 * slice (nothing to check against) or the type belongs to that slice. Used by
 * the caller's skip rule — this is what makes re-runs idempotent AND forces
 * re-assignment when a product's category changed out from under its old type.
 */
export function isSpecTypeCurrent(
  existingType: string | null | undefined,
  categoryPath: string | null | undefined,
  validTypesNorm: ReadonlySet<string>,
): boolean {
  const t = existingType?.trim();
  if (!t || !validTypesNorm.has(normSpecType(t))) return false;
  const slice = categoryPath ? productTypesForCategoryPath(categoryPath) : null;
  if (!slice?.length) return true;
  const tn = normSpecType(t);
  return slice.some((s) => normSpecType(s) === tn);
}

/**
 * Deterministic pre-pass: a full type name occurring in the product name as
 * whole words IS the answer — no AI needed ("Bonide Mosquito Beater Area
 * Repellent Granules" contains "Area Repellent Granules"? no — but "Table
 * Lamps" in "Modern Table Lamps Set of 2" is). Longest match wins; distinct
 * equal-length matches are ambiguous → null. With requireMultiWord, only
 * multi-word type names qualify (used against the FULL 7K list, where
 * single-word hits like "Rugs" are too promiscuous to trust).
 */
export function matchSpecTypeByName(
  name: string,
  types: readonly string[],
  opts?: { requireMultiWord?: boolean },
): string | null {
  const haystack = ` ${normSpecType(name)} `;
  if (haystack.trim().length < 4) return null;
  let best: string | null = null;
  let bestNorm = "";
  let tie = false;
  for (const t of types) {
    if (opts?.requireMultiWord && !/\s/.test(t.trim())) continue;
    const tn = normSpecType(t);
    if (tn.length < 4) continue;
    if (!haystack.includes(` ${tn} `)) continue;
    if (tn.length > bestNorm.length) { best = t; bestNorm = tn; tie = false; }
    else if (tn.length === bestNorm.length && tn !== bestNorm) tie = true;
  }
  return tie ? null : best;
}

/**
 * Tolerant extraction of the model's [{index, productType}] reply. The kimi
 * models wrap output in markdown fences and prose despite instructions; a
 * truncated reply can still carry recoverable per-object fragments. Returns
 * null when nothing parseable is present — the caller MUST count that as a
 * failed attempt (the old code silently blanked the whole batch).
 */
export function parseSpecTypeReply(
  text: string,
): Array<{ index: number; productType: string }> | null {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const tryParse = (s: string): unknown[] | null => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  let arr: unknown[] | null = tryParse(cleaned);
  if (!arr) arr = tryParse(cleaned.match(/\[[\s\S]*\]/)?.[0] ?? "");
  if (!arr) {
    // Per-object recovery for truncated/prose-wrapped replies.
    const objs = [
      ...cleaned.matchAll(
        /\{[^{}]*?"index"\s*:\s*"?(\d+)"?[^{}]*?"productType"\s*:\s*"((?:[^"\\]|\\.)*)"[^{}]*?\}/g,
      ),
    ];
    if (!objs.length) return null;
    arr = objs.map((m) => {
      let pt = "";
      try { pt = JSON.parse(`"${m[2]}"`) as string; } catch { pt = m[2]!; }
      return { index: Number(m[1]), productType: pt };
    });
  }
  const out: Array<{ index: number; productType: string }> = [];
  for (const r of arr as Array<{ index?: unknown; productType?: unknown }>) {
    const idx = Number(r?.index);
    if (!Number.isFinite(idx) || idx < 1) continue;
    out.push({ index: idx, productType: String(r?.productType ?? "").trim() });
  }
  return out.length ? out : null;
}

// ── Assignment ────────────────────────────────────────────────────────────────

export type SpecTypeInput = { id: string; name: string; brand?: string | null; description?: string | null; category?: string | null };

export type SpecAssignOptions = {
  /** Epoch ms — stop cleanly before this; unattempted work resumes next run. */
  deadlineAt?: number;
  /** Progress callback (products settled so far, total). */
  onProgress?: (done: number, total: number) => void;
  /** Durable per-batch persistence, awaited before the next wave — a deadline
   *  stop then loses nothing. */
  onAssigned?: (rows: Array<{ productId: string; specProductType: string }>) => Promise<void>;
};

export type SpecAssignResult = {
  /** productId → verbatim taxonomy type (pre-pass + AI, validated). */
  assigned: Map<string, string>;
  /** Products actually processed (pre-pass or sent to the AI). */
  attempted: number;
  /** True when the deadline cut work short — the caller reports partial/resume. */
  deadlineHit: boolean;
};

const BATCH = 15;
const CONCURRENCY = 3;
const MAX_ATTEMPTS = 3;

/**
 * Assign a valid Spec Product Type to each product. Never throws; products the
 * model can't place stay out of the map (blank-for-retry — the caller's skip
 * rule re-attempts them on the next run rather than persisting a guess).
 */
export async function assignSpecProductTypes(
  products: SpecTypeInput[],
  opts?: SpecAssignOptions,
): Promise<SpecAssignResult> {
  const assigned = new Map<string, string>();
  const res: SpecAssignResult = { assigned, attempted: 0, deadlineHit: false };
  if (!products.length || !moonshotConfigured()) return res;

  const types = await loadSpecProductTypes();
  if (!types.length) return res; // taxonomy unavailable → leave blank

  // Fall back to the shared text-model default — the old hardcoded
  // "moonshot-v1-auto" fallback 404s since the v1 line was retired.
  const model = process.env.CATEGORIZE_MODEL ?? MOONSHOT_TEXT_MODEL;

  // Canonical maps: normalized answer → verbatim taxonomy value.
  const globalCanon = new Map<string, string>();
  for (const t of types) globalCanon.set(normSpecType(t), t);

  // Scope each product to its path's slice of the type list; unresolved paths
  // fall into the "" bucket against the full list (dispatched LAST — the most
  // expensive, least accurate work is what a deadline should cut first).
  type Scope = { sliceTypes: string[] | null; canon: Map<string, string>; items: SpecTypeInput[] };
  const byScope = new Map<string, Scope>();
  for (const p of products) {
    const scoped = p.category ? productTypesForCategoryPath(p.category) : null;
    const key = scoped ? p.category!.trim() : "";
    if (!byScope.has(key)) {
      const canon = scoped ? new Map(scoped.map((t) => [normSpecType(t), t])) : globalCanon;
      byScope.set(key, { sliceTypes: scoped, canon, items: [] });
    }
    byScope.get(key)!.items.push(p);
  }

  const total = products.length;
  const flush = async (rows: Array<{ productId: string; specProductType: string }>) => {
    if (rows.length && opts?.onAssigned) await opts.onAssigned(rows);
  };
  const progress = () => opts?.onProgress?.(Math.min(res.attempted, total), total);

  // ── Deterministic pre-pass ─────────────────────────────────────────────────
  // A whole type name inside the product name is the answer without any AI.
  const preRows: Array<{ productId: string; specProductType: string }> = [];
  for (const scope of byScope.values()) {
    const remaining: SpecTypeInput[] = [];
    for (const p of scope.items) {
      const hit = matchSpecTypeByName(p.name, scope.sliceTypes ?? types, {
        requireMultiWord: !scope.sliceTypes,
      });
      if (hit) {
        assigned.set(p.id, hit);
        preRows.push({ productId: p.id, specProductType: hit });
        res.attempted++;
      } else {
        remaining.push(p);
      }
    }
    scope.items = remaining;
  }
  await flush(preRows);
  progress();

  // ── AI batches ─────────────────────────────────────────────────────────────
  type SpecBatch = { typeList: string; canon: Map<string, string>; batch: SpecTypeInput[] };
  const scopedBatches: SpecBatch[] = [];
  const fullListBatches: SpecBatch[] = [];
  const fullTypeList = types.map((t) => `- ${t}`).join("\n");
  for (const [key, scope] of byScope) {
    const typeList = scope.sliceTypes ? scope.sliceTypes.map((t) => `- ${t}`).join("\n") : fullTypeList;
    const target = key === "" ? fullListBatches : scopedBatches;
    for (let i = 0; i < scope.items.length; i += BATCH) {
      target.push({ typeList, canon: scope.canon, batch: scope.items.slice(i, i + BATCH) });
    }
  }
  const batches = [...scopedBatches, ...fullListBatches];

  /** One model call over one batch; returns the ids it settled. */
  const callModel = async (b: SpecBatch): Promise<Array<{ productId: string; specProductType: string }>> => {
    const list = b.batch
      .map((p, idx) => {
        let line = `${idx + 1}. "${p.name}"`;
        if (p.brand) line += ` by ${p.brand}`;
        if (p.category) line += ` [category: ${p.category}]`;
        if (p.description) line += ` — ${p.description.slice(0, 150)}`;
        return line;
      })
      .join("\n");

    const { text } = await generateText({
      model: moonshot(model),
      prompt: `You are a Walmart listing expert. Assign each product the single best "Spec Product Type" from Walmart's official list below.

Rules:
1. Decide from the product NAME (plus brand/description) — what the item physically IS. The [category] tag only tells you which slice of the taxonomy you are in; it is NOT the answer and must not be echoed back as the product type.
2. Pick the most SPECIFIC type that matches the product — never a broad catch-all (anything like "Other", "All X" or a generic parent term) when a narrower listed type plainly fits.
3. Copy the chosen value character-for-character from the list. Never invent, abbreviate, or paraphrase a type.
4. Use "" (empty) ONLY when genuinely no listed type describes the item — not because the name is short or the category tag is vague.

Valid Spec Product Types:
${b.typeList}

Products:
${list}

Respond ONLY with a JSON array, no markdown:
[{"index":1,"productType":"<exact value or empty>"},...]`,
      // Reasoning models (kimi-k line) spend output budget thinking before the
      // JSON — a small cap returns an empty/truncated reply for a 15-item batch.
      maxOutputTokens: 3000,
      temperature: moonshotTemperature(model, 0.2),
    });

    const parsed = parseSpecTypeReply(text);
    if (!parsed) throw new Error("unparseable spec-type reply");

    const rows: Array<{ productId: string; specProductType: string }> = [];
    for (const r of parsed) {
      const p = b.batch[r.index - 1];
      if (!p || !r.productType) continue;
      // Slice validation + normalized salvage: only a value from this batch's
      // OWN scope is accepted (an out-of-slice answer means the model ignored
      // the list); a case/plural/punctuation near-miss canonicalizes onto the
      // listed value. Anything else stays blank for the next run's retry.
      const canonical = b.canon.get(normSpecType(r.productType));
      if (canonical) rows.push({ productId: p.id, specProductType: canonical });
    }
    return rows;
  };

  /** Retry wrapper: MAX_ATTEMPTS with backoff; a final failure of a multi-item
   *  batch splits in half for one more attempt each (isolates a poison item). */
  const runBatch = async (b: SpecBatch, attempts = MAX_ATTEMPTS): Promise<void> => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const rows = await callModel(b);
        for (const r of rows) assigned.set(r.productId, r.specProductType);
        await flush(rows);
        return;
      } catch (err) {
        // Account-level failure: no retry or split can help, and the route
        // must report the cause instead of a silent all-blank pass.
        if (classifyAiError(err).fatal) throw err;
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        if (b.batch.length > 1) {
          const mid = Math.ceil(b.batch.length / 2);
          await runBatch({ ...b, batch: b.batch.slice(0, mid) }, 1);
          await runBatch({ ...b, batch: b.batch.slice(mid) }, 1);
          return;
        }
        console.warn(`[spec-product-type] batch of ${b.batch.length} failed after ${attempts} attempt(s):`, err);
      }
    }
  };

  // Dispatch in concurrency waves, checking the deadline before each wave so a
  // time-budget stop leaves whole batches for the next run instead of cutting
  // one off mid-flight.
  let batchMsTotal = 0;
  let batchesRun = 0;
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    // Provider outage: stop dispatching. Nothing would be assigned, and the
    // route records the reason as specTypeError for the user to see.
    const outage = getAiOutage();
    if (outage) throw new AiUnavailableError(outage.reason);
    if (opts?.deadlineAt) {
      const avg = batchesRun > 0 ? batchMsTotal / batchesRun : 8_000;
      if (Date.now() + avg * 1.25 > opts.deadlineAt) {
        res.deadlineHit = true;
        break;
      }
    }
    const wave = batches.slice(i, i + CONCURRENCY);
    const began = Date.now();
    await Promise.all(wave.map((b) => runBatch(b)));
    batchMsTotal += Date.now() - began;
    batchesRun += wave.length;
    res.attempted += wave.reduce((n, b) => n + b.batch.length, 0);
    progress();
  }

  // ── Leftover re-pass ───────────────────────────────────────────────────────
  // Items whose batch ran but stayed blank (empty answers, out-of-slice picks)
  // get one more chance in half-size batches. Whatever remains after this is an
  // honest blank for the next run.
  if (!res.deadlineHit) {
    const leftovers: SpecBatch[] = [];
    for (const b of batches) {
      const missing = b.batch.filter((p) => !assigned.has(p.id));
      for (let i = 0; i < missing.length; i += Math.ceil(BATCH / 2)) {
        leftovers.push({ ...b, batch: missing.slice(i, i + Math.ceil(BATCH / 2)) });
      }
    }
    for (let i = 0; i < leftovers.length; i += CONCURRENCY) {
      if (opts?.deadlineAt && Date.now() > opts.deadlineAt - 10_000) {
        res.deadlineHit = true;
        break;
      }
      await Promise.all(leftovers.slice(i, i + CONCURRENCY).map((b) => runBatch(b, 1)));
      progress();
    }
  }

  return res;
}
