"use client";

import { useState } from "react";
import { Activity, AlertTriangle, Pencil } from "lucide-react";
import { formatDuration } from "@/lib/utils";
import { formatDateTime } from "@/lib/format-date";
import { Card, EmptyState, Pill, StatRow, StatTile } from "@/components/ui/primitives";

type UserRow = {
  userId: string;
  name: string | null;
  email: string;
  calls: number;
  failed: number;
  sessions: number;
  busyMs: number;
  spanMs: number;
  rowsWritten: number;
  lastUsedAt: string;
  topTools: { tool: string; calls: number }[];
};

type SessionRow = {
  email: string;
  startedAt: string;
  endedAt: string;
  spanMs: number;
  busyMs: number;
  calls: number;
  failed: number;
  rowsWritten: number;
  projectIds: string[];
  trail: string[];
};

/**
 * Two views of the same thing, because they answer different questions.
 * "Who is using this" is a per-person total; "what did they do" is a session.
 */
export function McpUsageClient({
  users,
  sessions,
  projectNames,
}: {
  users: UserRow[];
  sessions: SessionRow[];
  projectNames: Record<string, string>;
}) {
  const [tab, setTab] = useState<"people" | "sessions">("people");

  const totals = users.reduce(
    (t, u) => ({
      calls: t.calls + u.calls,
      sessions: t.sessions + u.sessions,
      busyMs: t.busyMs + u.busyMs,
      rows: t.rows + u.rowsWritten,
    }),
    { calls: 0, sessions: 0, busyMs: 0, rows: 0 },
  );

  if (!users.length) {
    return (
      <EmptyState icon={Activity} title="Nobody has used Claude with Mercato yet">
        Once somebody connects and asks Claude something, their sessions appear here — which tools
        they used, on which projects, and for how long.
      </EmptyState>
    );
  }

  return (
    <>
      <StatRow className="mb-6">
        <StatTile label="People" value={users.length} />
        <StatTile label="Sessions" value={totals.sessions} note="last 30 days" />
        <StatTile label="Tool calls" value={totals.calls.toLocaleString()} />
        <StatTile
          label="Rows changed"
          value={totals.rows.toLocaleString()}
          tone={totals.rows > 0 ? "warning" : "neutral"}
          note={totals.rows > 0 ? "by a write tool" : "read-only so far"}
        />
      </StatRow>

      <div className="mb-4 flex w-fit gap-1 rounded-lg bg-muted p-1">
        {(["people", "sessions"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              tab === t
                ? "rounded-md bg-background px-3 py-1.5 text-sm font-medium shadow"
                : "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
            }
          >
            {t === "people" ? "By person" : "Sessions"}
          </button>
        ))}
      </div>

      {tab === "people" ? (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-muted-foreground [&>th]:whitespace-nowrap">
                <th className="px-4 py-2.5 font-medium">Person</th>
                <th className="px-4 py-2.5 font-medium">Sessions</th>
                <th className="px-4 py-2.5 font-medium">Calls</th>
                <th className="px-4 py-2.5 font-medium">Time in tools</th>
                <th className="px-4 py-2.5 font-medium">Changed</th>
                <th className="px-4 py-2.5 font-medium">Most used</th>
                <th className="px-4 py-2.5 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.userId} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <p className="font-medium">{u.name ?? u.email}</p>
                    {u.name && <p className="text-xs text-muted-foreground">{u.email}</p>}
                  </td>
                  <td className="px-4 py-3 tabular-nums">{u.sessions}</td>
                  <td className="px-4 py-3 tabular-nums">
                    {u.calls}
                    {u.failed > 0 && (
                      <Pill tone="warning" icon={AlertTriangle} className="ml-2">
                        {u.failed} failed
                      </Pill>
                    )}
                  </td>
                  {/* Time INSIDE the tools, not time with Claude open — the
                      difference is large and claiming the latter would be a
                      made-up number. */}
                  <td className="px-4 py-3 tabular-nums">{formatDuration(u.busyMs) ?? "—"}</td>
                  <td className="px-4 py-3 tabular-nums">
                    {u.rowsWritten > 0 ? (
                      <Pill tone="warning" icon={Pencil}>{u.rowsWritten.toLocaleString()} rows</Pill>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {u.topTools.slice(0, 3).map((t) => (
                        <Pill key={t.tool}>
                          {t.tool} ×{t.calls}
                        </Pill>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{formatDateTime(u.lastUsedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map((s, i) => (
            <Card key={i} className="p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-medium">{s.email}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDateTime(s.startedAt)} · {formatDuration(s.spanMs) ?? "a moment"} ·{" "}
                  {s.calls} call{s.calls === 1 ? "" : "s"}
                  {s.failed > 0 && <span className="text-[var(--status-warning)]"> · {s.failed} failed</span>}
                  {s.rowsWritten > 0 && (
                    <span className="text-[var(--status-warning)]"> · {s.rowsWritten} rows changed</span>
                  )}
                </p>
              </div>
              {/* The trail IS the answer to "what was this about" — as far as
                  Mercato can honestly tell. It never sees the conversation. */}
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                {s.trail.join(" → ")}
              </p>
              {s.projectIds.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {s.projectIds.map((p) => (
                    <Pill key={p}>{projectNames[p] ?? p}</Pill>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
