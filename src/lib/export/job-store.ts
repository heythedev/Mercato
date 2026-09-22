import { prisma } from "@/lib/db";

/**
 * Durable export-job store, backed by the ExportJob table.
 *
 * The original store was a module-level Map — fine on Render's single
 * persistent process, broken on Vercel where each instance has its own memory:
 * a status poll could land on an instance that had never heard of the job
 * ("Job not found or expired" forever), and a finished ZIP evaporated whenever
 * the instance that built it was frozen or recycled. Keeping the row — ZIP
 * included — in Postgres makes polls and downloads work from any instance and
 * lets a finished export survive until pruning (48h).
 *
 * Status reads and payload reads are separate on purpose: the client polls
 * every couple of seconds, and the ZIP column must not ride along on each poll.
 */

export type ExportJobStatus = {
  status: "processing" | "done" | "error";
  phase: string | null;
  error: string | null;
  updatedAt: Date;
  extension: string | null;
  contentType: string | null;
  missingTemplateCategories: string[];
  /** REQUIRED cells that shipped empty, and whether AI was even able to try. */
  unfilledRequired: UnfilledReport;
  userId: string;
};

/** One required column an export could not fill, and how many rows it affected.
 *  `label` is the template's own header, which is what defaultFor() matches on. */
export type UnfilledColumn = { label: string; rows: number };

/**
 * What an export could not fill, and whether that verdict is trustworthy.
 *
 * `aiUnavailable` is the difference between "no source on earth can answer this
 * column" and "the AI was out of credit so nothing even tried". They look
 * identical in the output — both are empty cells — and conflating them is
 * dangerous: a per-product attribute like Finish Color or Seat Height would be
 * offered as a candidate for a fixed default, and accepting that writes one
 * wrong value into every row of every future export.
 */
export type UnfilledReport = {
  columns: UnfilledColumn[];
  aiUnavailable: boolean;
  /**
   * Whether the AI verdict was actually recorded for this run.
   *
   * Rows written before the flag existed stored a bare array, and there is no
   * way to tell afterwards whether those runs had a working AI. Treating them
   * as "AI was fine" is wrong in at least one direction, so anything that draws
   * a CONCLUSION from empty cells — like suggesting a column is unanswerable —
   * must require this to be true rather than trusting the default.
   */
  recorded: boolean;
};

/** Older rows stored a bare array, before the AI-availability flag existed. */
export function toUnfilledReport(raw: unknown): UnfilledReport {
  if (Array.isArray(raw)) {
    return { columns: raw as UnfilledColumn[], aiUnavailable: false, recorded: false };
  }
  const o = (raw ?? {}) as Partial<UnfilledReport>;
  return { columns: o.columns ?? [], aiUnavailable: !!o.aiUnavailable, recorded: Array.isArray(o.columns) };
}

const RETENTION_MS = 48 * 60 * 60 * 1000;

export async function createJob(id: string, projectId: string, userId: string): Promise<void> {
  // Prune expired jobs first so ZIP blobs don't accumulate. Best-effort: a
  // failed prune must not block starting the export.
  await prisma.exportJob
    .deleteMany({ where: { updatedAt: { lt: new Date(Date.now() - RETENTION_MS) } } })
    .catch(() => {});
  // NOT best-effort: if this row can't be written the client's polls would 404
  // with no explanation — better to fail the POST loudly.
  await prisma.exportJob.create({ data: { id, projectId, userId } });
}

/**
 * Bump a processing job's heartbeat without changing its phase.
 *
 * The client treats an advancing `updatedAt` as proof of life. Long single
 * operations (a multi-minute catalog back-fill, one giant title batch) set one
 * phase and then go quiet, which the client's stall detector reads as a dead
 * export — call this on an interval while such an operation runs.
 */
export async function touchJob(id: string): Promise<void> {
  await prisma.exportJob
    .updateMany({ where: { id, status: "processing" }, data: { updatedAt: new Date() } })
    .catch(() => {});
}

/** Report the current phase so the client can show real progress. */
export async function setJobPhase(id: string, phase: string): Promise<void> {
  await prisma.exportJob
    .updateMany({ where: { id, status: "processing" }, data: { phase, updatedAt: new Date() } })
    .catch(() => {});
}

export async function resolveJob(
  id: string,
  zip: Buffer,
  meta?: {
    extension?: string;
    contentType?: string;
    missingTemplateCategories?: string[];
    unfilledRequired?: UnfilledReport;
  },
): Promise<void> {
  await prisma.exportJob.update({
    where: { id },
    data: {
      status: "done",
      // Copy into a fresh Uint8Array: Prisma 7's Bytes input is typed
      // Uint8Array<ArrayBuffer>, which Node's Buffer (ArrayBufferLike) isn't.
      zip: new Uint8Array(zip),
      extension: meta?.extension ?? "zip",
      contentType: meta?.contentType ?? "application/zip",
      missingTemplateCategories: meta?.missingTemplateCategories ?? [],
      unfilledRequired: meta?.unfilledRequired ?? { columns: [], aiUnavailable: false },
      updatedAt: new Date(),
    },
  });
}

export async function rejectJob(id: string, error: string): Promise<void> {
  // Best-effort: if the DB is the thing that's failing, this write may fail
  // too — the client's stall detector then reports the dead job instead.
  await prisma.exportJob
    .updateMany({
      where: { id },
      data: { status: "error", error: error.slice(0, 2000), updatedAt: new Date() },
    })
    .catch(() => {});
}

/** Job state WITHOUT the ZIP payload — safe to poll frequently. */
export async function getJobStatus(id: string): Promise<ExportJobStatus | null> {
  const j = await prisma.exportJob.findUnique({
    where: { id },
    select: {
      status: true,
      phase: true,
      error: true,
      updatedAt: true,
      extension: true,
      contentType: true,
      missingTemplateCategories: true,
      unfilledRequired: true,
      userId: true,
    },
  });
  if (!j) return null;
  return {
    status: j.status as ExportJobStatus["status"],
    phase: j.phase,
    error: j.error,
    updatedAt: j.updatedAt,
    extension: j.extension,
    contentType: j.contentType,
    missingTemplateCategories: (j.missingTemplateCategories as string[] | null) ?? [],
    unfilledRequired: toUnfilledReport(j.unfilledRequired),
    userId: j.userId,
  };
}

/** The finished payload — fetched once, only after status is "done". */
export async function getJobZip(id: string): Promise<Uint8Array | null> {
  const j = await prisma.exportJob.findUnique({ where: { id }, select: { zip: true } });
  return j?.zip ?? null;
}
