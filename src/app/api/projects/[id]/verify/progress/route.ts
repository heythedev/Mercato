import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";

/**
 * Incremental verification results.
 *
 * Verification commits each batch to the database as it completes, but the main
 * project endpoint returns every product with its full `verifyFields` payload —
 * far too heavy to poll during a run on a 10k catalog. This returns only what
 * the results list needs to render, only for products already verified, in
 * stable order, with a cursor so the client fetches each product exactly once.
 *
 * Ordering is by `verifiedAt` then `id`: verification writes results in batches,
 * so newly finished products always sort after everything already fetched. The
 * `id` tiebreak matters because a whole batch shares one `verifiedAt` timestamp
 * — without it, rows within a batch could interleave across pages and be
 * skipped or duplicated.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, userId: true, status: true, verifyMs: true, verifyCompletedAt: true },
  });
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = req.nextUrl;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
  // Cursor is "<verifiedAt ISO>|<id>" from the previous page's last row.
  const rawCursor = url.searchParams.get("cursor");

  let cursorFilter = {};
  if (rawCursor) {
    const sep = rawCursor.lastIndexOf("|");
    const at = new Date(rawCursor.slice(0, sep));
    const cid = rawCursor.slice(sep + 1);
    if (!Number.isNaN(at.getTime()) && cid) {
      // Strictly after (verifiedAt, id) in the composite ordering.
      cursorFilter = {
        OR: [
          { verifiedAt: { gt: at } },
          { verifiedAt: { equals: at }, id: { gt: cid } },
        ],
      };
    }
  }

  const where = {
    projectId: id,
    verifiedAt: { not: null },
    verifyStatus: { not: null },
    ...cursorFilter,
  };

  const [rows, verifiedTotal, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ verifiedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true, name: true, vendorSku: true, upc: true, asin: true,
        brand: true, price: true, imageUrl: true, verifyStatus: true,
        verifyFields: true, verifiedAt: true,
      },
    }),
    prisma.product.count({
      where: { projectId: id, verifiedAt: { not: null }, verifyStatus: { not: null } },
    }),
    prisma.product.count({ where: { projectId: id } }),
  ]);

  // Status tallies for the summary cards, computed server-side so the client
  // doesn't need every product loaded to show accurate counts.
  const grouped = await prisma.product.groupBy({
    by: ["verifyStatus"],
    where: { projectId: id },
    _count: true,
  });
  const counts: Record<string, number> = {};
  for (const g of grouped) if (g.verifyStatus) counts[g.verifyStatus] = g._count;

  const last = rows[rows.length - 1];
  const nextCursor =
    last?.verifiedAt ? `${last.verifiedAt.toISOString()}|${last.id}` : rawCursor;

  return NextResponse.json({
    products: rows,
    nextCursor,
    // True when this page reached the end of what is currently verified. More
    // may appear later while the run is still going — `running` says which.
    exhausted: rows.length < limit,
    verifiedTotal,
    total,
    counts,
    running: project.status === "verifying",
    verifyMs: project.verifyMs,
    verifyCompletedAt: project.verifyCompletedAt,
  });
}
