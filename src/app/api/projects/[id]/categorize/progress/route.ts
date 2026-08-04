import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";

/**
 * Incremental categorization results — the categorize-step analogue of the
 * verify/progress feed.
 *
 * Categorization commits each wave to the database as it completes (see the
 * onResults hook wired in categorize/route.ts), but the main project endpoint
 * returns every product — too heavy to poll during a run on a large catalog.
 * This returns only what the results table needs to render, only for products
 * already categorized in the CURRENT run, in stable order, with a cursor so
 * the client fetches each product exactly once.
 *
 * Ordering is by `categorizedAt` then `id`, same reasoning as verify/progress:
 * a whole wave shares one timestamp, so the `id` tiebreak prevents rows within
 * a wave from being skipped or duplicated across pages.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    select: { id: true, userId: true, status: true, categorizeMs: true, categorizeCompletedAt: true },
  });
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = req.nextUrl;
  const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
  // Cursor is "<categorizedAt ISO>|<id>" from the previous page's last row.
  const rawCursor = url.searchParams.get("cursor");

  let cursorFilter = {};
  if (rawCursor) {
    const sep = rawCursor.lastIndexOf("|");
    const at = new Date(rawCursor.slice(0, sep));
    const cid = rawCursor.slice(sep + 1);
    if (!Number.isNaN(at.getTime()) && cid) {
      cursorFilter = {
        OR: [
          { categorizedAt: { gt: at } },
          { categorizedAt: { equals: at }, id: { gt: cid } },
        ],
      };
    }
  }

  const where = {
    projectId: id,
    categorizedAt: { not: null },
    ...cursorFilter,
  };

  const [rows, categorizedTotal, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [{ categorizedAt: "asc" }, { id: "asc" }],
      take: limit,
      select: {
        id: true, name: true, marketplaceCategory: true, categoryPath: true,
        categoryConfidence: true, categorizedAt: true,
      },
    }),
    prisma.product.count({ where: { projectId: id, categorizedAt: { not: null } } }),
    prisma.product.count({ where: { projectId: id } }),
  ]);

  const last = rows[rows.length - 1];
  const nextCursor =
    last?.categorizedAt ? `${last.categorizedAt.toISOString()}|${last.id}` : rawCursor;

  return NextResponse.json({
    products: rows,
    nextCursor,
    // True when this page reached the end of what is currently categorized. More
    // may appear later while the run is still going — `running` says which.
    exhausted: rows.length < limit,
    categorizedTotal,
    total,
    running: project.status === "categorizing",
    categorizeMs: project.categorizeMs,
    categorizeCompletedAt: project.categorizeCompletedAt,
  });
}
