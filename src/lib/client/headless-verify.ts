"use client";

// Headless verify + image-sweep driver for the multi-project Run Queue
// (run-queue-context.tsx). Deliberately independent of project-detail.tsx's
// own runVerify: that version is wired into ONE page's component state
// (setProducts, toasts, the live product list) and refactoring it to also
// serve a background, no-page-open caller would risk the working single-
// project flow for no benefit — this file re-implements the same resume and
// retry shape against a status callback instead.
//
// Covers BOTH stages a user means by "Verify": the marketplace lookup passes
// AND the background image sweep that follows them (verify-step.tsx's sweep
// effect fires only while that page is mounted — a queue-driven run has no
// page mounted, so it has to drive the sweep itself or "Verify" would finish
// with every image still pending).

export type RunStatus = {
  phase: "verifying" | "images" | "done" | "error" | "paused";
  done: number;
  total: number;
  message?: string;
};

type VerifyPassResponse = {
  error?: string;
  code?: string;
  resumable?: boolean;
  verified?: number;
  skipped?: number;
  remaining?: number;
  complete?: boolean;
  aiUnavailable?: string;
};

type SweepResponse = {
  processed: number;
  nextCursor: string | null;
  pendingTotal: number;
  aiUnavailable?: string;
  error?: string;
};

const RETRY_DELAYS_MS = [15_000, 30_000, 45_000, 90_000];

async function postWithRetry<T>(url: string, body?: unknown): Promise<{ res: Response | null; data: T | null }> {
  let res: Response | null = null;
  let data: T | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]));
    try {
      res = await fetch(url, {
        method: "POST",
        ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
      });
    } catch {
      res = null;
      continue;
    }
    if (res.status === 502 || res.status === 503 || res.status === 504) continue;
    data = await res.json().catch(() => null);
    if (data !== null) break;
  }
  return { res, data };
}

/**
 * Runs the marketplace-lookup resume loop to completion, then the background
 * image sweep to completion, reporting progress via `onStatus`. Resolves when
 * there is nothing left to do, the AI provider is unavailable (a "paused"
 * status — not an error, the caller can offer Retry later), or a genuine
 * failure stops the run.
 */
export async function runVerifyHeadless(
  projectId: string,
  onStatus: (s: RunStatus) => void,
  shouldStop: () => boolean,
): Promise<void> {
  let totalVerified = 0;
  let totalSkipped = 0;

  for (let pass = 0; pass < 25; pass++) {
    if (shouldStop()) return;
    const { res, data } = await postWithRetry<VerifyPassResponse>(`/api/projects/${projectId}/verify?ai=1`);
    if (!res || !data) {
      onStatus({ phase: "error", done: totalVerified, total: totalVerified, message: "Server did not respond — try again from the project page." });
      return;
    }
    if (!res.ok) {
      if (data.code === "INSUFFICIENT_KEEPA_TOKENS") {
        onStatus({ phase: "paused", done: totalVerified, total: totalVerified, message: data.error ?? "Not enough Keepa tokens" });
        return;
      }
      onStatus({ phase: "error", done: totalVerified, total: totalVerified, message: data.error ?? "Verification failed" });
      return;
    }
    totalVerified += data.verified ?? 0;
    totalSkipped += data.skipped ?? 0;
    const remaining = data.remaining ?? 0;
    onStatus({
      phase: "verifying",
      done: totalVerified,
      total: totalVerified + remaining,
      ...(totalSkipped > 0 ? { message: `${totalSkipped} skipped (tokens ran low) — previous results kept` } : {}),
    });
    if (remaining > 0 && data.verified) continue;
    break;
  }

  // Image sweep — same eligibility rule the page's own effect uses, driven
  // here instead since no page is mounted to run it.
  let cursor = "";
  let announcedTotal: number | null = null;
  for (let round = 0; round < 3; round++) {
    for (;;) {
      if (shouldStop()) return;
      const { res, data } = await postWithRetry<SweepResponse>(`/api/projects/${projectId}/verify/images`, { cursor });
      if (!res || !data) {
        onStatus({ phase: "error", done: 0, total: 0, message: "Image sweep lost connection." });
        return;
      }
      if (data.aiUnavailable) {
        onStatus({ phase: "paused", done: 0, total: announcedTotal ?? 0, message: data.aiUnavailable });
        return;
      }
      if (announcedTotal === null) announcedTotal = data.pendingTotal + data.processed;
      onStatus({
        phase: "images",
        done: Math.max(0, announcedTotal - data.pendingTotal),
        total: announcedTotal,
      });
      if (!data.nextCursor) {
        if (data.pendingTotal <= 0) {
          onStatus({ phase: "done", done: announcedTotal, total: announcedTotal });
          return;
        }
        break; // round finished with some pending left — retry round
      }
      cursor = data.nextCursor;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  onStatus({ phase: "done", done: announcedTotal ?? 0, total: announcedTotal ?? 0 });
}
