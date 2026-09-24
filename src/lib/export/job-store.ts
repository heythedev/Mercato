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
  /** Output groups still to write. Empty once the job is ready to assemble. */
  pendingGroups: string[];
  /** How many groups the job started with, for progress. */
  totalGroups: number;
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

/**
 * Record the work a job still has to do.
 *
 * An export is built one slice per request: a 4,811-product Mathis catalogue
 * does not fit in a single 300-second serverless invocation, and before this
 * every attempt was killed at the ceiling and threw away everything it had
 * written — five identical failures at 4.7 minutes, each starting from zero.
 */
export async function setJobPlan(id: string, groups: string[]): Promise<void> {
  await prisma.exportJob.update({
    where: { id },
    data: { pendingGroups: groups, totalGroups: groups.length, updatedAt: new Date() },
  });
}

/** Mark groups finished, leaving the rest for the next request. */
export async function markGroupsDone(id: string, done: string[]): Promise<string[]> {
  const job = await prisma.exportJob.findUnique({
    where: { id },
    select: { pendingGroups: true },
  });
  const pending = ((job?.pendingGroups as string[] | null) ?? []).filter((g) => !done.includes(g));
  await prisma.exportJob.update({
    where: { id },
    data: { pendingGroups: pending, updatedAt: new Date() },
  });
  return pending;
}

/**
 * Store the files one slice produced.
 *
 * Written before the slice reports success, so a function killed at the
 * ceiling still leaves finished work behind. `skipDuplicates` makes a retried
 * slice harmless: the same file written twice is the same file.
 */
export async function saveJobFiles(
  id: string,
  files: { name: string; data: Buffer }[],
): Promise<void> {
  if (files.length === 0) return;
  // One at a time: these are whole spreadsheets, and a single createMany
  // carrying a dozen of them is a needless multi-megabyte statement.
  for (const f of files) {
    await prisma.exportJobFile
      .create({ data: { jobId: id, name: f.name, data: new Uint8Array(f.data) } })
      .catch(() => {
        /* already stored by an earlier attempt at this slice */
      });
  }
}

/** Names of the files a job has finished, so a slice can skip them. */
export async function jobFileNames(id: string): Promise<string[]> {
  const rows = await prisma.exportJobFile.findMany({
    where: { jobId: id },
    select: { name: true },
  });
  return rows.map((r) => r.name);
}

/**
 * Fold the stored files into the finished ZIP and drop the parts.
 *
 * Reads them one at a time rather than in a single findMany: the parts of a
 * large export add up to the whole download, and pulling every row into memory
 * at once is how this ran out of heap before.
 */
export async function assembleJobZip(id: string): Promise<Buffer> {
  const names = await prisma.exportJobFile.findMany({
    where: { jobId: id },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  for (const n of names) {
    const row = await prisma.exportJobFile.findUnique({
      where: { id: n.id },
      select: { data: true },
    });
    if (row?.data) zip.file(n.name, Buffer.from(row.data));
  }
  const out = (await zip.generateAsync({ type: "nodebuffer" })) as unknown as Buffer;
  await prisma.exportJobFile.deleteMany({ where: { jobId: id } }).catch(() => {});
  return out;
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
      pendingGroups: true,
      totalGroups: true,
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
    pendingGroups: (j.pendingGroups as string[] | null) ?? [],
    totalGroups: j.totalGroups ?? 0,
    userId: j.userId,
  };
}

/** The finished payload — fetched once, only after status is "done". */
export async function getJobZip(id: string): Promise<Uint8Array | null> {
  const j = await prisma.exportJob.findUnique({ where: { id }, select: { zip: true } });
  return j?.zip ?? null;
}
