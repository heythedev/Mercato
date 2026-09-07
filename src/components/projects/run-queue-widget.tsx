"use client";

import { useSyncExternalStore } from "react";
import { Loader2, X, CheckCircle2, AlertTriangle, PauseCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { runQueue, type RunEntry } from "@/lib/client/run-queue-store";
import type { RunStatus } from "@/lib/client/headless-verify";
import type { CategorizeStatus } from "@/lib/client/headless-categorize";

/**
 * Floating status panel for the multi-project Run Queue — visible from any
 * page in the app (mounted once in the authenticated layout) so starting a
 * run from the projects list doesn't require staying on that page, or on any
 * one project's page, to see it progress. Renders nothing when the queue is
 * empty, which is the common case.
 */
export function RunQueueWidget() {
  const { active, queue } = useSyncExternalStore(runQueue.subscribe, runQueue.getSnapshot, runQueue.getSnapshot);

  if (active.length === 0 && queue.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-[320px] max-w-[calc(100vw-2rem)] flex flex-col gap-2">
      {active.map((entry) => <RunCard key={entry.projectId} entry={entry} />)}
      {queue.length > 0 && (
        <div className="rounded-xl border bg-card/95 backdrop-blur px-3.5 py-2.5 shadow-lg text-xs text-muted-foreground">
          {queue.length} more project{queue.length === 1 ? "" : "s"} queued — starts as a slot frees up
        </div>
      )}
    </div>
  );
}

function describe(kind: "verify" | "categorize", status: RunStatus | CategorizeStatus | null): {
  label: string; sub: string | null; done: boolean; failed: boolean; paused: boolean;
} {
  const verb = kind === "verify" ? "Verifying" : "Categorizing";
  if (!status) return { label: `${verb}…`, sub: "Starting…", done: false, failed: false, paused: false };

  if (kind === "verify") {
    const s = status as RunStatus;
    if (s.phase === "error") return { label: `${verb} failed`, sub: s.message ?? null, done: false, failed: true, paused: false };
    if (s.phase === "paused") return { label: "Paused — AI unavailable", sub: s.message ?? null, done: false, failed: false, paused: true };
    if (s.phase === "done") return { label: "Verify complete", sub: s.total ? `${s.total} products` : null, done: true, failed: false, paused: false };
    const stageLabel = s.phase === "images" ? "Checking images" : "Verifying";
    return {
      label: `${stageLabel}…`,
      sub: s.total > 0 ? `${s.done.toLocaleString()} of ${s.total.toLocaleString()}` : null,
      done: false, failed: false, paused: false,
    };
  }

  const s = status as CategorizeStatus;
  if (s.phase === "error") return { label: "Categorize failed", sub: s.message ?? null, done: false, failed: true, paused: false };
  if (s.phase === "paused") return { label: "Paused — AI unavailable", sub: s.message ?? null, done: false, failed: false, paused: true };
  if (s.phase === "done") return { label: "Categorize complete", sub: s.message ?? null, done: true, failed: false, paused: false };
  return { label: "Categorizing…", sub: s.message ?? null, done: false, failed: false, paused: false };
}

function RunCard({ entry }: { entry: RunEntry }) {
  const { label, sub, done, failed, paused } = describe(entry.kind, entry.status);
  const pct =
    entry.status && "total" in entry.status && entry.status.total > 0
      ? Math.round((100 * entry.status.done) / entry.status.total)
      : null;

  return (
    <div className="rounded-xl border bg-card/95 backdrop-blur px-3.5 py-3 shadow-lg">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0">
          {done ? <CheckCircle2 className="w-4 h-4 text-green-600" />
            : failed ? <AlertTriangle className="w-4 h-4 text-red-600" />
            : paused ? <PauseCircle className="w-4 h-4 text-yellow-600" />
            : <Loader2 className="w-4 h-4 animate-spin text-primary" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold truncate">{entry.projectName}</p>
          <p className={cn(
            "text-[11px] mt-0.5 truncate",
            failed ? "text-red-600" : paused ? "text-yellow-700 dark:text-yellow-500" : "text-muted-foreground",
          )}>
            {label}{sub ? ` — ${sub}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => runQueue.cancel(entry.projectId)}
          title="Stop"
          aria-label="Stop this run"
          className="shrink-0 -mt-0.5 -mr-1 p-1 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {pct != null && !done && (
        <div className="w-full bg-muted rounded-full h-1 mt-2.5">
          <div className="bg-primary h-1 rounded-full transition-all" style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
    </div>
  );
}
