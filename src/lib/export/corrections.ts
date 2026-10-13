import { prisma } from "@/lib/db";
import { profileFor } from "@/lib/marketplaces/profile";
import { normalizeKey } from "./zip";

/**
 * What a person changed after a model or a catalogue lookup produced it.
 *
 * This stores and does not act. That is the whole design for now, and it is
 * deliberate: the useful thing to build first is the record, because you
 * cannot learn from data you never kept, and every day without it is a day of
 * signal thrown away. What consumes it — suggesting a rule, showing accepted
 * answers as examples — can be decided later against real rows rather than
 * against a guess about what people correct.
 *
 * It is also the safe order. A system that quietly adjusts its own behaviour
 * from corrections will eventually propagate a wrong one across a whole
 * catalogue with nothing reporting it, which is the same shape as the bug
 * that put a UPC in Variation Group ID — except self-inflicted and spreading.
 * A visible table somebody reads cannot do that.
 */

export type CorrectionSource = "catalog" | "ai";

export type RecordedCorrection = {
  productId?: string | null;
  marketplace: string;
  category?: string | null;
  attribute: string;
  /** What the model or the lookup produced. */
  was: string;
  /** What the person made it. */
  corrected: string;
  wasSource: CorrectionSource;
  userId?: string | null;
};

/** Values that mean "there was nothing here", which is not a correction. */
function isBlank(v: unknown): boolean {
  const s = String(v ?? "").trim();
  return !s || /^(n\/?a|none|null|-+)$/i.test(s);
}

/**
 * Whether a change is evidence of a disagreement, or just a change.
 *
 * Pure, and separate from the write, because this is the judgement the whole
 * table depends on and it has to be checkable without a database.
 */
export function isCorrection(was: unknown, corrected: unknown): boolean {
  if (isBlank(was) || isBlank(corrected)) return false;
  return normalizeKey(String(was).trim()) !== normalizeKey(String(corrected).trim());
}

/**
 * Record one correction, or decide it is not one.
 *
 * Three things are refused, each because recording them would make the table
 * lie about what people actually disagree with:
 *
 *   Filling a blank. Nothing was wrong; a gap was closed. Counting it as a
 *   correction would make every unfilled column look like a column the model
 *   keeps getting wrong.
 *
 *   Clearing a value. That says "no answer is better than this one", which is
 *   worth knowing, but it is not an example of the right answer and must not
 *   later be offered as one.
 *
 *   A change that is only spelling or spacing. "polyethylene" to
 *   "Polyethylene" is the template's own casing rule, not a judgement about
 *   the product.
 */
export async function recordCorrection(c: RecordedCorrection): Promise<boolean> {
  if (!isCorrection(c.was, c.corrected)) return false;

  const was = String(c.was).trim();
  const corrected = String(c.corrected).trim();

  try {
    await prisma.attributeCorrection.create({
      data: {
        productId: c.productId ?? null,
        marketplace: profileFor(c.marketplace).id,
        category: c.category ?? null,
        attribute: normalizeKey(c.attribute),
        was,
        corrected,
        wasSource: c.wasSource,
        userId: c.userId ?? null,
      },
    });
    return true;
  } catch (e) {
    // Never fails the write it is observing. A correction that is not recorded
    // costs a row in a table nothing reads yet; a correction that throws costs
    // the person their edit.
    console.warn(`[corrections] could not record ${c.attribute}:`, (e as Error).message);
    return false;
  }
}

/** Record several, one row each, without letting one failure sink the rest. */
export async function recordCorrections(list: RecordedCorrection[]): Promise<number> {
  let n = 0;
  for (const c of list) if (await recordCorrection(c)) n++;
  return n;
}

export type CorrectionSummary = {
  marketplace: string;
  attribute: string;
  count: number;
  /** The most frequent replacement, and how often it was chosen. */
  mostCommon: { value: string; count: number } | null;
};

/**
 * What is being corrected, most often first.
 *
 * The question this answers is "which columns are we getting wrong", which is
 * the one worth asking before building anything that acts on the answers. A
 * column corrected twice is noise; a column corrected two hundred times with
 * the same replacement is a rule somebody should write down.
 */
export async function correctionSummary(
  marketplace?: string,
  limit = 50,
): Promise<CorrectionSummary[]> {
  const rows = await prisma.attributeCorrection.findMany({
    where: marketplace ? { marketplace: profileFor(marketplace).id } : {},
    select: { marketplace: true, attribute: true, corrected: true },
    take: 5000,
    orderBy: { createdAt: "desc" },
  });

  const byKey = new Map<string, { marketplace: string; attribute: string; values: Map<string, number> }>();
  for (const r of rows) {
    const key = `${r.marketplace}\u0000${r.attribute}`;
    const hit = byKey.get(key) ?? { marketplace: r.marketplace, attribute: r.attribute, values: new Map() };
    hit.values.set(r.corrected, (hit.values.get(r.corrected) ?? 0) + 1);
    byKey.set(key, hit);
  }

  return [...byKey.values()]
    .map((h) => {
      const count = [...h.values.values()].reduce((a, b) => a + b, 0);
      let mostCommon: { value: string; count: number } | null = null;
      for (const [value, n] of h.values) {
        if (!mostCommon || n > mostCommon.count) mostCommon = { value, count: n };
      }
      return { marketplace: h.marketplace, attribute: h.attribute, count, mostCommon };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}
