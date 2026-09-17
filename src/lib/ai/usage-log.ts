import { currentAiContext } from "./usage-context";

/**
 * Durable record of what each billable third-party call cost.
 *
 * None of the three paid services can tell you afterwards where a balance went:
 * Kimi exposes a balance and no usage history (probed: /users/me/balance
 * answers, /users/me/usage and every sibling 404), while Keepa and Synccentric
 * report a running quota per response but keep no breakdown by project or
 * feature. So the only account of a drained balance is the one we keep.
 *
 * Writes are buffered. A verification sweep makes several calls per product and
 * runs ten at a time, so a row-per-call insert would contend with the same small
 * pg pool the sweep itself is using — the starvation problem inChunks() exists
 * to avoid. Rows are flushed in batches instead, and a flush failure is
 * swallowed: losing usage rows must never fail the work they describe.
 */

export type UsageService = "kimi" | "keepa" | "synccentric";

export type UsageRow = {
  service: UsageService;
  /** Model id for AI calls; absent for the metered data providers. */
  model?: string;
  feature: string;
  projectId?: string;
  userId?: string;
  inputTokens: number;
  outputTokens: number;
  /** Keepa tokens consumed / Synccentric searches used; 0 for AI rows. */
  units: number;
  durationMs?: number;
  ok: boolean;
};

const FLUSH_AT = 25;
const FLUSH_AFTER_MS = 3000;
/** A runaway buffer would be a memory leak in a long sweep; drop oldest past this. */
const MAX_BUFFER = 500;

let buffer: UsageRow[] = [];
let timer: NodeJS.Timeout | null = null;

/** Disabled under test: unit tests exercise these paths with no database. */
const enabled = process.env.NODE_ENV !== "test" && !process.env.VITEST;

type UsageInput = Omit<UsageRow, "projectId" | "userId" | "inputTokens" | "outputTokens" | "units"> &
  Partial<Pick<UsageRow, "inputTokens" | "outputTokens" | "units" | "projectId" | "userId">>;

/**
 * Record one billable call. Project and user come from the ambient context the
 * route established (src/lib/ai/usage-context.ts), so a Keepa lookup made deep
 * inside a verification run is still attributed to the project that paid for it.
 */
export function recordUsageRow(row: UsageInput): void {
  if (!enabled) return;
  const ctx = currentAiContext();
  buffer.push({
    inputTokens: 0,
    outputTokens: 0,
    units: 0,
    ...row,
    projectId: row.projectId ?? ctx.projectId,
    userId: row.userId ?? ctx.userId,
  });
  if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER);

  if (buffer.length >= FLUSH_AT) {
    void flushUsage();
    return;
  }
  // Low-volume callers (a single template detection) would otherwise sit in the
  // buffer until some unrelated call happened to fill it.
  timer ??= setTimeout(() => {
    timer = null;
    void flushUsage();
  }, FLUSH_AFTER_MS);
  timer.unref?.();
}

/**
 * Write buffered rows. Safe to call at any time; callers about to finish a long
 * job (an export, a verification run) should await it so a frozen serverless
 * instance does not take the tail of the run with it.
 */
export async function flushUsage(): Promise<void> {
  if (!enabled || buffer.length === 0) return;
  const rows = buffer;
  buffer = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    const { prisma } = await import("@/lib/db");
    await prisma.serviceUsage.createMany({ data: rows });
  } catch (e) {
    // Usage accounting is never worth failing real work over, but silence would
    // make a broken table look like an idle account.
    console.warn(`[usage] flush failed (${rows.length} rows dropped):`, String(e).slice(0, 200));
  }
}

/** Rows waiting to be written — exposed for the admin report and for tests. */
export function pendingUsageRows(): number {
  return buffer.length;
}
