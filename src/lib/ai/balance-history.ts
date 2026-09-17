/**
 * Spend measured from the provider's own balance, with no rate involved.
 *
 * A token count multiplied by a configured price is always an estimate: the
 * rate is maintained by hand, and cached input tokens bill differently from
 * fresh ones without the totals distinguishing them. The balance does not have
 * that problem — the provider has already done the arithmetic, and the drop
 * between two readings is exactly the money spent.
 */

export type Snapshot = { balanceCents: number; capturedAt: Date };

/**
 * Money spent across a series of readings, in cents.
 *
 * Only DECREASES count. A rise means a top-up, and netting it off would hide
 * the spend on either side of it: $50 spent, $50 added and $50 spent again must
 * read as $100, not $50. An unchanged balance contributes nothing.
 *
 * Readings must be ordered oldest first; unordered input is sorted rather than
 * trusted, because a caller that pages the query would otherwise report
 * nonsense.
 */
export function spentCents(snapshots: Snapshot[]): number {
  if (snapshots.length < 2) return 0;
  const ordered = [...snapshots].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  let spent = 0;
  for (let i = 1; i < ordered.length; i++) {
    const delta = ordered[i - 1].balanceCents - ordered[i].balanceCents;
    if (delta > 0) spent += delta;
  }
  return spent;
}

/** Spend per calendar day, keyed YYYY-MM-DD in the given IANA zone. */
export function spentByDay(snapshots: Snapshot[], timeZone = "Asia/Kolkata"): Map<string, number> {
  const ordered = [...snapshots].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const out = new Map<string, number>();
  for (let i = 1; i < ordered.length; i++) {
    const delta = ordered[i - 1].balanceCents - ordered[i].balanceCents;
    if (delta <= 0) continue;
    // Attributed to the day the spend was OBSERVED, which is the later reading:
    // that is the only day we can honestly assign it to without pretending to
    // know when inside the gap it happened.
    const day = fmt.format(ordered[i].capturedAt);
    out.set(day, (out.get(day) ?? 0) + delta);
  }
  return out;
}

/** Whether a new reading is worth storing, given the last one. */
export function shouldSnapshot(
  last: Snapshot | null,
  now: Date,
  balanceCents: number,
  minIntervalMs = 5 * 60 * 1000,
): boolean {
  if (!last) return true;
  // A changed balance is always worth a row — it is the event being measured.
  if (last.balanceCents !== balanceCents) return true;
  // An unchanged balance still gets an occasional row so a quiet period is
  // visible as quiet rather than as missing data.
  return now.getTime() - last.capturedAt.getTime() >= minIntervalMs;
}

// ── Persistence ───────────────────────────────────────────────────────────────

let lastStored: Snapshot | null = null;

/**
 * Store a balance reading, throttled.
 *
 * Never throws and never blocks the caller: a missing table or a database blip
 * costs one data point, and the balance itself is still reported live from the
 * provider. Fire-and-forget from fetchMoonshotBalance.
 */
export async function snapshotBalance(availableBalance: number | null): Promise<void> {
  if (typeof availableBalance !== "number" || !Number.isFinite(availableBalance)) return;
  const balanceCents = Math.round(availableBalance * 100);
  const now = new Date();
  if (!shouldSnapshot(lastStored, now, balanceCents)) return;
  // Optimistic: set before the write so a burst of concurrent probes does not
  // queue a row each.
  lastStored = { balanceCents, capturedAt: now };
  try {
    const { prisma } = await import("@/lib/db");
    await prisma.balanceSnapshot.create({ data: { service: "kimi", balanceCents, capturedAt: now } });
  } catch {
    // Roll back the throttle so the next probe tries again rather than the
    // table silently staying empty for the rest of the instance's life.
    lastStored = null;
  }
}
