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
  userId: string;
};

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
  meta?: { extension?: string; contentType?: string; missingTemplateCategories?: string[] },
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
    userId: j.userId,
  };
}

/** The finished payload — fetched once, only after status is "done". */
export async function getJobZip(id: string): Promise<Uint8Array | null> {
  const j = await prisma.exportJob.findUnique({ where: { id }, select: { zip: true } });
  return j?.zip ?? null;
}
