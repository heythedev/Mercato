type ExportJob = {
  status: "processing" | "done" | "error";
  zip?: Buffer;
  error?: string;
  createdAt: number;
  /** Human-readable phase ("Generating titles…") shown while the job runs. */
  phase?: string;
  /** Last time the job reported progress — lets the client distinguish a
   *  still-working job from a genuinely stalled one. */
  updatedAt: number;
  /**
   * File extension of the stored payload ("zip", "xlsx", "csv").
   *
   * A single-file export (Walmart always produces one sheet) is served as the
   * bare spreadsheet rather than a ZIP holding one entry, so the download is
   * something the user can open directly.
   */
  extension?: string;
  /** MIME type matching `extension`. */
  contentType?: string;
  /** Temu categories that had no matching template and were excluded from the export. */
  missingTemplateCategories?: string[];
};

// Module-level singleton — survives across requests in the same Node.js process.
// Works on Render (persistent server). Does not survive restarts.
//
// NOTE: this is per-process. On a multi-instance deployment a poll can land on
// an instance that does not hold the job and will 404 forever. Moving the ZIP
// to object storage (S3/R2) keyed by jobId is the fix if this is ever scaled
// past one instance.
const jobs = new Map<string, ExportJob>();

export function createJob(id: string): void {
  const now = Date.now();
  jobs.set(id, { status: "processing", createdAt: now, updatedAt: now });
  pruneOldJobs();
}

/** Report the current phase so the client can show real progress. */
/**
 * Bump a processing job's heartbeat without changing its phase.
 *
 * The client treats an advancing `updatedAt` as proof of life. Long single
 * operations (a multi-minute product load against a remote database) set one
 * phase and then go quiet, which the client's stall detector reads as a dead
 * export — call this on an interval while such an operation runs.
 */
export function touchJob(id: string): void {
  const j = jobs.get(id);
  if (j && j.status === "processing") {
    jobs.set(id, { ...j, updatedAt: Date.now() });
  }
}

export function setJobPhase(id: string, phase: string): void {
  const j = jobs.get(id);
  if (j && j.status === "processing") {
    jobs.set(id, { ...j, phase, updatedAt: Date.now() });
  }
}

export function resolveJob(
  id: string,
  zip: Buffer,
  meta?: { extension?: string; contentType?: string; missingTemplateCategories?: string[] },
): void {
  const j = jobs.get(id);
  if (j) {
    jobs.set(id, {
      ...j,
      status: "done",
      zip,
      extension: meta?.extension ?? "zip",
      contentType: meta?.contentType ?? "application/zip",
      missingTemplateCategories: meta?.missingTemplateCategories ?? [],
      updatedAt: Date.now(),
    });
  }
}

export function rejectJob(id: string, error: string): void {
  const j = jobs.get(id);
  if (j) jobs.set(id, { ...j, status: "error", error, updatedAt: Date.now() });
}

export function getJob(id: string): ExportJob | undefined {
  return jobs.get(id);
}

function pruneOldJobs(): void {
  // Keyed on updatedAt, not createdAt: a long-running export kept reporting
  // progress but its createdAt kept ageing, so a slow job could be pruned out
  // from under itself — or a just-finished ZIP evicted before the user's poll
  // collected it.
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, j] of jobs) {
    if (j.updatedAt < cutoff) jobs.delete(id);
  }
}
