// In-process job store for categorization runs.
//
// Categorizing several-thousand-product Walmart / Mathis projects makes dozens of
// serial model round-trips and easily runs past the 300 s serverless request
// limit — the HTTP request that kicked it off would time out even though the
// work eventually finishes. Mirroring the export job-store, the POST route
// starts the run in the background and returns a jobId immediately; the client
// polls GET until the job reports done/error. Unlike the export store this
// holds a small JSON summary rather than a file buffer.

export type CategorizeResultSummary = {
  categorized: number;
  matched: number;
  unmatched: number;
  reprocessed: number;
  enrichedFromSku: number;
  categories: string[];
};

type CategorizeJob = {
  status: "processing" | "done" | "error";
  result?: CategorizeResultSummary;
  error?: string;
  createdAt: number;
  /** Human-readable phase ("Categorizing 240/3000…") shown while the job runs. */
  phase?: string;
  /** Last progress timestamp — lets the client tell a slow job from a stalled one. */
  updatedAt: number;
};

// Module-level singleton — survives across requests in the same Node.js process
// (Render runs a persistent server). Does not survive restarts. On a
// multi-instance deployment a poll can land on an instance that does not hold
// the job; the same caveat applies to the export store and is out of scope here.
const jobs = new Map<string, CategorizeJob>();

export function createCategorizeJob(id: string): void {
  const now = Date.now();
  jobs.set(id, { status: "processing", createdAt: now, updatedAt: now });
  pruneOldJobs();
}

export function setCategorizeJobPhase(id: string, phase: string): void {
  const j = jobs.get(id);
  if (j && j.status === "processing") {
    jobs.set(id, { ...j, phase, updatedAt: Date.now() });
  }
}

export function resolveCategorizeJob(id: string, result: CategorizeResultSummary): void {
  const j = jobs.get(id);
  if (j) jobs.set(id, { ...j, status: "done", result, updatedAt: Date.now() });
}

export function rejectCategorizeJob(id: string, error: string): void {
  const j = jobs.get(id);
  if (j) jobs.set(id, { ...j, status: "error", error, updatedAt: Date.now() });
}

export function getCategorizeJob(id: string): CategorizeJob | undefined {
  return jobs.get(id);
}

function pruneOldJobs(): void {
  // Keyed on updatedAt so a long-running job that keeps reporting progress is
  // never pruned out from under itself.
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, j] of jobs) {
    if (j.updatedAt < cutoff) jobs.delete(id);
  }
}
