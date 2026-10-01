import { prisma } from "@/lib/db";

/**
 * What happened over MCP: who, which tool, which project, how long.
 *
 * Two needs met by one table. The first is the audit trail — write tools can
 * change a live catalogue and nothing else records that Claude did it, for
 * whom, through which token. The second is the question "is anyone actually
 * using this", which until now could only be answered by a token's
 * lastUsedAt, a single timestamp that says nothing about what was done.
 *
 * What is NOT recorded is the conversation. Mercato sees the calls a client
 * makes; it never sees what the person typed or what Claude said back. The
 * tool trail describes what a session was ABOUT — "listed projects, opened
 * the Mathis one, checked export readiness" — and that is genuinely useful,
 * but it is an inference and not a transcript. Saying otherwise would promise
 * a kind of visibility this does not have.
 */

export type CallRecord = {
  userId: string;
  tokenId: string;
  sessionId?: string | null;
  tool: string;
  projectId?: string | null;
  ok: boolean;
  error?: string | null;
  durationMs: number;
  /** Rows a write changed. Null for reads. */
  rows?: number | null;
};

/**
 * Best-effort by design: a failure to record must never fail the call it was
 * recording. An audit row is worth having and not worth breaking somebody's
 * export for.
 */
export async function recordCall(c: CallRecord): Promise<void> {
  try {
    await prisma.mcpCall.create({
      data: {
        userId: c.userId,
        tokenId: c.tokenId,
        sessionId: c.sessionId ?? null,
        tool: c.tool,
        projectId: c.projectId ?? null,
        ok: c.ok,
        // Truncated: a stack trace in an audit row helps nobody and the
        // column should stay small enough to read in a table.
        error: c.error ? c.error.slice(0, 300) : null,
        durationMs: Math.max(0, Math.round(c.durationMs)),
        rows: c.rows ?? null,
      },
    });
  } catch (e) {
    console.warn("[mcp] could not record call:", (e as Error).message);
  }
}

/**
 * The project a call concerned, if its arguments name one.
 *
 * Read off the arguments rather than the result, so it is recorded even when
 * the call fails — a refused write on someone else's project is exactly the
 * kind of thing an audit trail exists to show.
 */
export function projectIdFromArgs(args: Record<string, unknown>): string | null {
  const v = args?.projectId;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * How many rows a write changed, dug out of its own result.
 *
 * The tools answer in their own shapes — `written` for a categorisation,
 * `changed` for a category set — so this reads either and returns null for a
 * read tool, which is what distinguishes the two in the record.
 */
export function rowsFromResult(text: string | undefined): number | null {
  if (!text) return null;
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    for (const k of ["written", "changed", "cleared"]) {
      if (typeof o[k] === "number") return o[k] as number;
    }
  } catch {
    // Not JSON, or not a write — either way there is no row count to report.
  }
  return null;
}

// ── Reading it back ─────────────────────────────────────────────────────────

export type StoredCall = {
  id: string;
  userId: string;
  tokenId: string;
  sessionId: string | null;
  tool: string;
  projectId: string | null;
  ok: boolean;
  durationMs: number;
  rows: number | null;
  createdAt: Date;
};

/**
 * A stretch of work by one person, with nothing much happening either side.
 *
 * MCP over HTTP has no session of its own unless the client sends
 * Mcp-Session-Id, and most do not — so a "session" is reconstructed: calls by
 * the same token, in order, split wherever the gap exceeds `gapMs`. Thirty
 * minutes because the thing being measured is a person working, and a person
 * who has not asked anything for half an hour has stopped.
 */
export const SESSION_GAP_MS = 30 * 60 * 1000;

export type Session = {
  userId: string;
  tokenId: string;
  startedAt: Date;
  endedAt: Date;
  /** Wall-clock from first call to last. Zero for a single-call session. */
  spanMs: number;
  /** Time actually spent inside Mercato's tools, which is far less. */
  busyMs: number;
  calls: number;
  failed: number;
  rowsWritten: number;
  projectIds: string[];
  /** The tools used, in order, each named once per run of repeats. */
  trail: string[];
};

export function groupIntoSessions(calls: StoredCall[], gapMs = SESSION_GAP_MS): Session[] {
  // Oldest first within each token, so a gap means what it looks like.
  const byToken = new Map<string, StoredCall[]>();
  for (const c of calls) {
    const key = c.sessionId ? `s:${c.sessionId}` : `t:${c.tokenId}`;
    if (!byToken.has(key)) byToken.set(key, []);
    byToken.get(key)!.push(c);
  }

  const out: Session[] = [];
  for (const [key, rows] of byToken) {
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    let run: StoredCall[] = [];
    const flush = () => {
      if (run.length) out.push(toSession(run));
      run = [];
    };
    for (const c of rows) {
      const prev = run[run.length - 1];
      // A client-supplied session id is authoritative; only reconstructed
      // sessions are split on time.
      const split = prev && !key.startsWith("s:") && c.createdAt.getTime() - prev.createdAt.getTime() > gapMs;
      if (split) flush();
      run.push(c);
    }
    flush();
  }
  return out.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}

function toSession(run: StoredCall[]): Session {
  const startedAt = run[0].createdAt;
  const endedAt = run[run.length - 1].createdAt;
  const trail: string[] = [];
  for (const c of run) if (trail[trail.length - 1] !== c.tool) trail.push(c.tool);
  return {
    userId: run[0].userId,
    tokenId: run[0].tokenId,
    startedAt,
    endedAt,
    // The last call's own duration counts: a session that ends on a 40-second
    // export check did not end when that call started.
    spanMs: endedAt.getTime() - startedAt.getTime() + run[run.length - 1].durationMs,
    busyMs: run.reduce((n, c) => n + c.durationMs, 0),
    calls: run.length,
    failed: run.filter((c) => !c.ok).length,
    rowsWritten: run.reduce((n, c) => n + (c.rows ?? 0), 0),
    projectIds: [...new Set(run.map((c) => c.projectId).filter((p): p is string => !!p))],
    trail,
  };
}

export type UserUsage = {
  userId: string;
  calls: number;
  failed: number;
  sessions: number;
  busyMs: number;
  spanMs: number;
  rowsWritten: number;
  lastUsedAt: Date;
  topTools: { tool: string; calls: number }[];
};

/** Per-person totals, busiest first. */
export function summariseByUser(sessions: Session[], calls: StoredCall[]): UserUsage[] {
  const byUser = new Map<string, UserUsage>();
  for (const s of sessions) {
    const u = byUser.get(s.userId) ?? {
      userId: s.userId,
      calls: 0, failed: 0, sessions: 0, busyMs: 0, spanMs: 0, rowsWritten: 0,
      lastUsedAt: s.endedAt,
      topTools: [],
    };
    u.sessions++;
    u.calls += s.calls;
    u.failed += s.failed;
    u.busyMs += s.busyMs;
    u.spanMs += s.spanMs;
    u.rowsWritten += s.rowsWritten;
    if (s.endedAt > u.lastUsedAt) u.lastUsedAt = s.endedAt;
    byUser.set(s.userId, u);
  }

  const toolCounts = new Map<string, Map<string, number>>();
  for (const c of calls) {
    if (!toolCounts.has(c.userId)) toolCounts.set(c.userId, new Map());
    const m = toolCounts.get(c.userId)!;
    m.set(c.tool, (m.get(c.tool) ?? 0) + 1);
  }
  for (const [userId, u] of byUser) {
    u.topTools = [...(toolCounts.get(userId) ?? new Map())]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([tool, n]) => ({ tool, calls: n }));
  }

  return [...byUser.values()].sort((a, b) => b.calls - a.calls);
}

/** Calls in a window, newest first, capped so one busy week cannot blow up the page. */
export async function recentCalls(sinceDays = 30, limit = 5000): Promise<StoredCall[]> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  return prisma.mcpCall.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true, userId: true, tokenId: true, sessionId: true, tool: true,
      projectId: true, ok: true, durationMs: true, rows: true, createdAt: true,
    },
  });
}
