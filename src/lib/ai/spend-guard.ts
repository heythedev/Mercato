import { prisma } from "@/lib/db";
import { getLastMoonshotBalance } from "@/lib/ai/moonshot";
import { flags } from "@/lib/flags";

/**
 * Stop work before the money runs out, rather than after.
 *
 * checkAiAvailable() already refuses when the balance is at or below zero.
 * That is the right behaviour and it is too late: on 24 September a Best Buy
 * export started with credit, ran out mid-run, and produced 1,422 questions
 * that were refused one at a time. The team learned the account was empty
 * from an export full of blank cells.
 *
 * The difference here is the word BEFORE. A run that cannot finish on the
 * balance it has should not begin — an export half-filled is worse than one
 * not started, because the half-filled one gets sent to a client.
 *
 * Two thresholds, because they answer different questions:
 *   floor   — below this, do not start. Hard.
 *   warn    — above the floor but low. Start, and say so.
 */

/** Below this, a new run is refused. Roughly a large export's worth. */
const FLOOR_USD = Number(process.env.AI_SPEND_FLOOR_USD ?? 5);
/** Below this, runs proceed with a warning attached. */
const WARN_USD = Number(process.env.AI_SPEND_WARN_USD ?? 20);

export type SpendCheck = {
  /** May a run start? */
  ok: boolean;
  /** Worth telling someone, whether or not it blocked. */
  warning: string | null;
  balanceUsd: number | null;
  /** What the last day actually cost, for an honest "this may not finish". */
  spentLast24hUsd: number | null;
};

/**
 * Yesterday's spend, measured from the balance rather than estimated from
 * tokens. Two readings a day apart is the provider's own arithmetic — no
 * price list, and cached tokens already accounted for.
 *
 * Top-ups are ignored rather than netted off: a recharge inside the window
 * would otherwise cancel out real spend and report a quiet day.
 */
async function spentLast24h(): Promise<number | null> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const snaps = await prisma.balanceSnapshot.findMany({
    where: { service: "kimi", capturedAt: { gte: since } },
    select: { balanceCents: true, capturedAt: true },
    orderBy: { capturedAt: "asc" },
  });
  if (snaps.length < 2) return null;

  let spentCents = 0;
  for (let i = 1; i < snaps.length; i++) {
    const drop = snaps[i - 1].balanceCents - snaps[i].balanceCents;
    // Only falls count. A rise is a top-up, not negative spend.
    if (drop > 0) spentCents += drop;
  }
  return spentCents / 100;
}

/**
 * Should this run start?
 *
 * `estimatedUsd` lets a caller say how much the work is likely to cost — an
 * export of 2,000 products is not the same question as categorising 20. When
 * given, the balance must cover it with the floor still intact.
 */
export async function checkSpendBudget(estimatedUsd?: number): Promise<SpendCheck> {
  // Switched off: behave exactly as before this existed — any credit at all
  // is enough to start. Kept removable because the estimate is an estimate,
  // and a wrong one blocking real work must be undoable in a minute rather
  // than a release.
  if (!flags.spendGuard()) {
    return { ok: true, warning: null, balanceUsd: null, spentLast24hUsd: null };
  }

  const bal = getLastMoonshotBalance();
  const balanceUsd = bal?.availableBalance ?? null;
  const spent = await spentLast24h().catch(() => null);

  // No reading is not a reason to block: the balance probe fails for reasons
  // that have nothing to do with money, and refusing every run because a
  // health check timed out would be its own outage.
  if (balanceUsd == null) {
    return { ok: true, warning: null, balanceUsd: null, spentLast24hUsd: spent };
  }

  const need = FLOOR_USD + (estimatedUsd ?? 0);
  if (balanceUsd < need) {
    return {
      ok: false,
      warning:
        `AI balance is $${balanceUsd.toFixed(2)}` +
        (estimatedUsd ? `, and this run is estimated at $${estimatedUsd.toFixed(2)}. ` : ". ") +
        `Below the $${FLOOR_USD} floor, runs are held rather than started, because an export that ` +
        `stops halfway ships blank cells to a client. Top up at platform.moonshot.ai.`,
      balanceUsd,
      spentLast24hUsd: spent,
    };
  }

  if (balanceUsd < WARN_USD) {
    return {
      ok: true,
      warning:
        `AI balance is $${balanceUsd.toFixed(2)}` +
        (spent != null ? ` and about $${spent.toFixed(2)} went in the last 24 hours` : "") +
        `. Worth topping up before a large run.`,
      balanceUsd,
      spentLast24hUsd: spent,
    };
  }

  return { ok: true, warning: null, balanceUsd, spentLast24hUsd: spent };
}

/**
 * A rough cost for a run, from what the same work has actually cost.
 *
 * Measured, not guessed: image verification averages ~4,200 input tokens a
 * call and categorisation batches 20-40 products per call. Prices come from
 * the same env vars the usage screen bills with, so one place to correct.
 */
export function estimateRunCostUsd(
  kind: "categorize" | "verify" | "export",
  products: number,
): number {
  const inPerM = Number(process.env.KIMI_PRICE_INPUT_PER_M ?? 0.6);
  const outPerM = Number(process.env.KIMI_PRICE_OUTPUT_PER_M ?? 2.5);
  const cost = (inTok: number, outTok: number) => (inTok / 1e6) * inPerM + (outTok / 1e6) * outPerM;

  switch (kind) {
    case "verify":
      // One call per product, ~4,200 in / ~240 out. This is 92% of the bill.
      return cost(products * 4200, products * 240);
    case "categorize":
      // ~30 products a call, and the prompt carries the taxonomy.
      return cost((products / 30) * 9750, (products / 30) * 1500);
    case "export":
      // Only the cells nothing else could fill; most rows ask nothing.
      return cost(products * 200, products * 20);
  }
}
