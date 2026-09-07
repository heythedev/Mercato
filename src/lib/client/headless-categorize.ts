"use client";

import { sleepForPoll } from "@/lib/poll-scheduler";

// Headless categorize driver for the multi-project Run Queue. Mirrors
// project-detail.tsx's own runCategorize resume/poll shape (same stall and
// no-progress bail-outs) against a status callback instead of component
// state and toasts — see headless-verify.ts for why this isn't shared code
// with the page's version.

export type CategorizeStatus = {
  phase: "categorizing" | "done" | "error" | "paused";
  message?: string;
};

type PollData = {
  status: string; error?: string; phase?: string; updatedAt?: number;
  matched?: number; unmatched?: number; categorized?: number;
  partial?: boolean; interrupted?: boolean; remaining?: number; resumeFrom?: number;
  specTypesRequested?: number; specTypesAssigned?: number; specTypesRemaining?: number;
  specTypeError?: string;
};

const STALL_LIMIT_MS = 5 * 60 * 1000;
const INVOCATION_LIMIT_MS = 12 * 60 * 1000;
const MAX_RESUMES = 40;

export async function runCategorizeHeadless(
  projectId: string,
  onStatus: (s: CategorizeStatus) => void,
  shouldStop: () => boolean,
): Promise<void> {
  let resumeFrom: number | null = null;
  let resumes = 0;
  let lastMatched = -1;
  let lastRemaining = Number.MAX_SAFE_INTEGER;
  let lastSpecRemaining = Number.MAX_SAFE_INTEGER;
  let noProgressResumes = 0;

  for (;;) {
    if (shouldStop()) return;
    let startRes: Response;
    try {
      startRes = await fetch(`/api/projects/${projectId}/categorize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resumeFrom !== null ? { resumeFrom } : {}),
      });
    } catch {
      onStatus({ phase: "error", message: "Could not reach the server." });
      return;
    }
    if (!startRes.ok) {
      const startData = await startRes.json().catch(() => ({ error: "Categorization failed" }));
      if (startData.code === "AI_UNAVAILABLE") {
        onStatus({ phase: "paused", message: startData.error ?? "AI is unavailable" });
        return;
      }
      onStatus({ phase: "error", message: startData.error ?? "Categorization failed" });
      return;
    }
    const { jobId, startedAt: logicalRunStart } = (await startRes.json()) as { jobId: string; startedAt?: number };
    if (resumeFrom === null && typeof logicalRunStart === "number") resumeFrom = logicalRunStart;

    const pollStartedAt = Date.now();
    let lastProgressAt = Date.now();
    let lastPhase = "";
    let lastUpdatedAt = 0;
    let pollFailures = 0;
    let verdict: PollData | null = null;

    while (Date.now() - pollStartedAt < INVOCATION_LIMIT_MS) {
      if (shouldStop()) return;
      await sleepForPoll(2500);

      let pollRes: Response;
      try {
        pollRes = await fetch(`/api/projects/${projectId}/categorize?jobId=${encodeURIComponent(jobId)}`);
      } catch {
        if (++pollFailures >= 5) {
          onStatus({ phase: "error", message: "Lost connection to the categorization run." });
          return;
        }
        continue;
      }
      const data = (await pollRes.json().catch(() => null)) as PollData | null;

      if (data?.status === "error") {
        onStatus({ phase: "error", message: data.error ?? "Categorization failed" });
        return;
      }
      if (!pollRes.ok || !data) {
        if (++pollFailures >= 5) {
          onStatus({ phase: "error", message: "Lost connection to the categorization run." });
          return;
        }
        continue;
      }
      pollFailures = 0;

      if (data.status === "done") {
        verdict = data;
        break;
      }
      if (data.phase && data.phase !== lastPhase) {
        lastPhase = data.phase;
        lastProgressAt = Date.now();
        onStatus({ phase: "categorizing", message: data.phase });
      }
      if (typeof data.updatedAt === "number" && data.updatedAt > lastUpdatedAt) {
        lastUpdatedAt = data.updatedAt;
        lastProgressAt = Date.now();
      }
      if (Date.now() - lastProgressAt > STALL_LIMIT_MS) {
        onStatus({ phase: "error", message: "Categorization stalled — no progress from the server." });
        return;
      }
    }

    if (!verdict) {
      onStatus({ phase: "error", message: "Categorization timed out." });
      return;
    }

    const matched = typeof verdict.matched === "number" ? verdict.matched : (verdict.categorized ?? 0);

    if (verdict.partial) {
      const remaining = typeof verdict.remaining === "number" ? verdict.remaining : Number.MAX_SAFE_INTEGER;
      const specRemaining = typeof verdict.specTypesRemaining === "number" ? verdict.specTypesRemaining : Number.MAX_SAFE_INTEGER;
      const progressed = matched > lastMatched || remaining < lastRemaining || specRemaining < lastSpecRemaining;
      lastMatched = Math.max(lastMatched, matched);
      lastRemaining = Math.min(lastRemaining, remaining);
      lastSpecRemaining = Math.min(lastSpecRemaining, specRemaining);
      noProgressResumes = progressed ? 0 : noProgressResumes + 1;
      if (noProgressResumes >= 2) {
        onStatus({ phase: "error", message: "Categorization kept stopping without progress." });
        return;
      }
      if (++resumes > MAX_RESUMES) {
        onStatus({ phase: "error", message: "Categorization needed too many rounds." });
        return;
      }
      if (typeof verdict.resumeFrom === "number") resumeFrom = verdict.resumeFrom;
      onStatus({ phase: "categorizing", message: `Resuming… (${matched} categorized so far)` });
      continue;
    }

    onStatus({ phase: "done", message: `Categorized ${matched} product${matched === 1 ? "" : "s"}` });
    return;
  }
}
