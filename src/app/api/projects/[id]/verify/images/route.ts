import { NextRequest, NextResponse } from "next/server";

// Each request adjudicates ONE small chunk and returns; the client loops with
// a cursor. Worst case per chunk is 6 image-pair downloads plus 6 vision calls,
// so 2 minutes is generous — and far below any proxy idle limit, which is the
// whole point of sweeping in chunks instead of inside the verify request.
export const maxDuration = 120;

import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { applyAiVerificationPasses, type VerifyResult } from "@/lib/marketplaces/verify";
import { checkAiAvailable } from "@/lib/ai/moonshot";
import {
  PENDING_MARKER,
  REQUEUE_NOTE_FRAGMENTS,
  hasComparablePair,
  needsImageRequeue,
} from "@/lib/marketplaces/image-check-state";

// Products per sweep request. Matches the comparison lib's concurrency (6): one
// chunk is one fully parallel wave of vision calls, and the 512 MB instance
// never holds more than 6 products' image bytes at once.
const CHUNK = 6;

type StoredField = {
  field: string;
  note?: string;
  stored?: string;
  liveImage?: string;
} & Record<string, unknown>;

type PendingRow = { id: string; name: string; verifyStatus: string; verifyFields: unknown };

/**
 * Cheap SQL text pre-filter (no per-row JSON parsing): rows whose fields still
 * carry the "not compared" pending marker, OR were closed without a verdict
 * during a provider outage (the note fragments in REQUEUE_NOTE_FRAGMENTS) —
 * those are re-queued and judged for real. Exact eligibility is decided in JS.
 */
const ELIGIBLE_SQL = Prisma.join(
  [PENDING_MARKER, ...REQUEUE_NOTE_FRAGMENTS].map(
    (frag) => Prisma.sql`"verifyFields"::text LIKE ${"%" + frag + "%"}`,
  ),
  " OR ",
);

/** Rows still waiting for an image verdict. Statuses beyond these three
 *  (not_found, discontinued) have no marketplace image to compare. */
async function countPending(projectId: string): Promise<number> {
  const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::int AS count
    FROM "Product"
    WHERE "projectId" = ${projectId}
      AND "verifyStatus" IN ('ok', 'warning', 'mismatch')
      AND (${ELIGIBLE_SQL})`;
  return count;
}

/**
 * Background AI image sweep: adjudicate the next chunk of verified products
 * whose images still carry the "not compared" marker.
 *
 * The verify route defers the AI post-pass here whenever the flagged set is
 * too large to run inside its own request. Every product this sweep touches
 * leaves it one of three ways — verdict written (marker gone), finalized as
 * "needs manual review" (marker gone), or a transient failure counted against
 * the field's retry budget until verify.ts finalizes it — so repeated calls
 * always terminate. Verdicts are persisted per chunk: a closed tab or dead
 * connection never loses progress, and the next caller resumes where this one
 * stopped.
 *
 * A provider OUTAGE (drained Kimi balance, rejected key, retired model) is
 * none of those three: nothing was learned, so nothing is written. The request
 * answers with `aiUnavailable` and the client stops looping and shows why.
 * Before this guard, a suspended account was recorded as three failed
 * attempts per product and then "Needs manual review" across whole catalogs.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, userId: true, marketplace: true },
  });
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { cursor?: unknown; fresh?: unknown };
  const cursor = typeof body.cursor === "string" ? body.cursor : "";
  // The client's manual "Retry" after a top-up: re-probe the balance live
  // instead of trusting the cached snapshot / outage marker.
  const fresh = body.fresh === true;

  try {
    // Preflight: don't download a single image if the provider can't answer.
    const availability = await checkAiAvailable({ fresh });
    if (!availability.ok) {
      return NextResponse.json({
        processed: 0,
        results: [],
        nextCursor: null,
        pendingTotal: await countPending(id),
        lastName: null,
        aiUnavailable: availability.reason,
      });
    }

    const rows = await prisma.$queryRaw<PendingRow[]>`
      SELECT id, name, "verifyStatus", "verifyFields"
      FROM "Product"
      WHERE "projectId" = ${id}
        AND "verifyStatus" IN ('ok', 'warning', 'mismatch')
        AND id > ${cursor}
        AND (${ELIGIBLE_SQL})
      ORDER BY id ASC
      LIMIT ${CHUNK}`;

    type Swept = { row: PendingRow; fields: StoredField[]; result: VerifyResult | null; changed: boolean };
    const swept: Swept[] = [];
    for (const row of rows) {
      const fields = Array.isArray(row.verifyFields) ? (row.verifyFields as StoredField[]) : [];
      const img = fields.find((f) => f.field === "images");
      const pending = !!img?.note?.includes(PENDING_MARKER);
      if (!img || (!pending && !needsImageRequeue(img))) {
        // The SQL pre-filter matched marker text somewhere other than the
        // images note (e.g. inside a vendor description). Nothing to do.
        swept.push({ row, fields, result: null, changed: false });
        continue;
      }
      if (!hasComparablePair(img)) {
        // Marker present but no comparable pair — finalize so the row leaves
        // the sweep instead of being re-selected forever. A re-queue candidate
        // without a pair is already finalized; leave it alone.
        if (pending) {
          img.note = "Needs manual review — one of the two images is missing, so AI could not compare them.";
        }
        swept.push({ row, fields, result: null, changed: pending });
        continue;
      }
      swept.push({
        row,
        fields,
        changed: true, // the AI pass rewrites the note (verdict, retry count, or finalization)
        result: {
          productId: row.id,
          status: row.verifyStatus as VerifyResult["status"],
          fields: fields as unknown as VerifyResult["fields"],
          liveData: { images: [img.liveImage] },
        },
      });
    }

    const results = swept.map((s) => s.result).filter((r): r is VerifyResult => !!r);
    let aiUnavailable: string | null = null;
    // Rows whose AI call hit the outage: their fields were left exactly as they
    // were and must not be re-persisted as if the AI had answered.
    const untouched = new Set<string>();
    if (results.length) {
      const productsArg = swept.filter((s) => s.result).map((s) => ({ id: s.row.id, name: s.row.name }));
      const { withImageCache } = await import("@/lib/ai/compare-images");
      // Runs BOTH post-passes: image comparison plus (Walmart) the semantic
      // title check, which is idempotent — settled titles are skipped.
      const outcome = await withImageCache(() =>
        applyAiVerificationPasses(
          results,
          productsArg as unknown as Parameters<typeof applyAiVerificationPasses>[1],
          project.marketplace,
          { onlyFlagged: true },
        ),
      );
      aiUnavailable = outcome.aiUnavailable;
      for (const pid of outcome.untouched) untouched.add(pid);
    }

    // At most CHUNK sequential single-row writes — no need for batching here.
    const persisted: Swept[] = [];
    for (const s of swept) {
      if (!s.changed || untouched.has(s.row.id)) continue;
      await prisma.product.update({
        where: { id: s.row.id },
        data: {
          verifyStatus: s.result ? s.result.status : s.row.verifyStatus,
          verifyFields: s.fields as unknown as Prisma.InputJsonValue,
        },
      });
      persisted.push(s);
    }

    // Remaining pending count AFTER this chunk's writes — drives the client's
    // progress banner and its decision to keep looping.
    const pendingTotal = await countPending(id);

    return NextResponse.json({
      processed: rows.length,
      results: persisted.map((s) => ({
        id: s.row.id,
        verifyStatus: s.result ? s.result.status : s.row.verifyStatus,
        verifyFields: s.fields,
      })),
      // An outage ends the loop: the client stops instead of walking the
      // cursor through a queue nothing can adjudicate.
      nextCursor: !aiUnavailable && rows.length === CHUNK ? rows[rows.length - 1].id : null,
      pendingTotal,
      lastName: rows.length ? rows[rows.length - 1].name : null,
      ...(aiUnavailable ? { aiUnavailable } : {}),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Image sweep failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
