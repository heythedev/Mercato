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

// Products per sweep request. Matches the comparison lib's concurrency (6): one
// chunk is one fully parallel wave of vision calls, and the 512 MB instance
// never holds more than 6 products' image bytes at once.
const CHUNK = 6;

/** Marker text set by the comparison-less verify path; an AI verdict (or a
 *  finalized manual-review note) replaces it. Kept in sync with
 *  needsImageCheck in ../route.ts and the images-field builder in
 *  lib/marketplaces/verify.ts. */
const PENDING_MARKER = "not compared";

type StoredField = {
  field: string;
  note?: string;
  stored?: string;
  liveImage?: string;
} & Record<string, unknown>;

type PendingRow = { id: string; name: string; verifyStatus: string; verifyFields: unknown };

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

  const body = (await req.json().catch(() => ({}))) as { cursor?: unknown };
  const cursor = typeof body.cursor === "string" ? body.cursor : "";

  try {
    // Cheap text pre-filter in SQL (no per-row JSON parsing); the exact
    // field-level eligibility check happens in JS below. Statuses beyond these
    // three (not_found, discontinued) have no marketplace image to compare.
    const rows = await prisma.$queryRaw<PendingRow[]>`
      SELECT id, name, "verifyStatus", "verifyFields"
      FROM "Product"
      WHERE "projectId" = ${id}
        AND "verifyStatus" IN ('ok', 'warning', 'mismatch')
        AND id > ${cursor}
        AND "verifyFields"::text LIKE ${"%" + PENDING_MARKER + "%"}
      ORDER BY id ASC
      LIMIT ${CHUNK}`;

    const isUrl = (v: unknown): v is string => typeof v === "string" && v.startsWith("http");

    type Swept = { row: PendingRow; fields: StoredField[]; result: VerifyResult | null; changed: boolean };
    const swept: Swept[] = [];
    for (const row of rows) {
      const fields = Array.isArray(row.verifyFields) ? (row.verifyFields as StoredField[]) : [];
      const img = fields.find((f) => f.field === "images");
      if (!img || !img.note?.includes(PENDING_MARKER)) {
        // The SQL pre-filter matched marker text somewhere other than the
        // images note (e.g. inside a vendor description). Nothing to do.
        swept.push({ row, fields, result: null, changed: false });
        continue;
      }
      if (!isUrl(img.stored) || !isUrl(img.liveImage)) {
        // Marker present but no comparable pair — finalize so the row leaves
        // the sweep instead of being re-selected forever.
        img.note = "Needs manual review — one of the two images is missing, so AI could not compare them.";
        swept.push({ row, fields, result: null, changed: true });
        continue;
      }
      swept.push({
        row,
        fields,
        changed: true, // the AI pass always rewrites the note (verdict, retry count, or finalization)
        result: {
          productId: row.id,
          status: row.verifyStatus as VerifyResult["status"],
          fields: fields as unknown as VerifyResult["fields"],
          liveData: { images: [img.liveImage] },
        },
      });
    }

    const results = swept.map((s) => s.result).filter((r): r is VerifyResult => !!r);
    if (results.length) {
      const productsArg = swept.filter((s) => s.result).map((s) => ({ id: s.row.id, name: s.row.name }));
      const { withImageCache } = await import("@/lib/ai/compare-images");
      // Runs BOTH post-passes: image comparison plus (Walmart) the semantic
      // title check, which is idempotent — settled titles are skipped.
      await withImageCache(() =>
        applyAiVerificationPasses(
          results,
          productsArg as unknown as Parameters<typeof applyAiVerificationPasses>[1],
          project.marketplace,
          { onlyFlagged: true },
        ),
      );
    }

    // At most CHUNK sequential single-row writes — no need for batching here.
    for (const s of swept) {
      if (!s.changed) continue;
      await prisma.product.update({
        where: { id: s.row.id },
        data: {
          verifyStatus: s.result ? s.result.status : s.row.verifyStatus,
          verifyFields: s.fields as unknown as Prisma.InputJsonValue,
        },
      });
    }

    // Remaining pending count AFTER this chunk's writes — drives the client's
    // progress banner and its decision to keep looping.
    const [{ count: pendingTotal }] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int AS count
      FROM "Product"
      WHERE "projectId" = ${id}
        AND "verifyStatus" IN ('ok', 'warning', 'mismatch')
        AND "verifyFields"::text LIKE ${"%" + PENDING_MARKER + "%"}`;

    return NextResponse.json({
      processed: rows.length,
      results: swept
        .filter((s) => s.changed)
        .map((s) => ({
          id: s.row.id,
          verifyStatus: s.result ? s.result.status : s.row.verifyStatus,
          verifyFields: s.fields,
        })),
      nextCursor: rows.length === CHUNK ? rows[rows.length - 1].id : null,
      pendingTotal,
      lastName: rows.length ? rows[rows.length - 1].name : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Image sweep failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
