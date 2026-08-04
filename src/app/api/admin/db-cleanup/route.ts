import { NextResponse } from "next/server";
import { adminGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";

// Admin-only DB maintenance. Exists because a storage-exceeded Render Postgres
// refuses external psql/adapter connections, but the running server can still
// reach it — so cleanup has to happen in-process.
//
//   GET  /api/admin/db-cleanup            → read-only report (sizes + projects by age)
//   POST /api/admin/db-cleanup            → purge regenerable caches, VACUUM
//   POST /api/admin/db-cleanup {olderThanDays: N, deleteProjects: true}
//                                         → ALSO delete projects older than N days
//                                           (their products cascade-delete)

// Caches only hold data we can re-fetch, so wiping them is always safe.
const CACHE_TABLES = ["KeepaProductCache", "WalmartItemCache", "KeepaCodeLookup"] as const;

export async function GET() {
  const { response } = await adminGuard();
  if (response) return response;

  const sizes = await prisma.$queryRawUnsafe<
    { table: string; rows: number; size: string }[]
  >(`
    SELECT relname AS "table", n_live_tup AS rows,
           pg_size_pretty(pg_total_relation_size(relid)) AS size
    FROM pg_stat_user_tables
    ORDER BY pg_total_relation_size(relid) DESC;
  `);

  const [{ total }] = await prisma.$queryRawUnsafe<{ total: string }[]>(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS total;`,
  );

  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      marketplace: true,
      status: true,
      createdAt: true,
      _count: { select: { products: true } },
    },
  });

  return NextResponse.json({
    totalDbSize: total,
    tables: sizes.map((s) => ({ ...s, rows: Number(s.rows) })),
    projects: projects.map((p) => ({
      id: p.id,
      name: p.name,
      marketplace: p.marketplace,
      status: p.status,
      createdAt: p.createdAt,
      products: p._count.products,
    })),
  });
}

export async function POST(req: Request) {
  const { response } = await adminGuard();
  if (response) return response;

  const body = (await req.json().catch(() => ({}))) as {
    deleteProjects?: boolean;
    olderThanDays?: number;
    confirm?: string;
  };

  const result: Record<string, unknown> = {};

  // 1. Always safe: truncate the regenerable caches.
  await prisma.$executeRawUnsafe(
    `TRUNCATE ${CACHE_TABLES.map((t) => `"${t}"`).join(", ")};`,
  );
  result.cachesTruncated = CACHE_TABLES;

  // 2. Optional, DESTRUCTIVE: delete old projects. Guarded three ways — an
  //    explicit flag, a positive cutoff, and a typed confirmation string — so it
  //    can never fire by accident.
  if (body.deleteProjects) {
    const days = body.olderThanDays;
    if (typeof days !== "number" || !Number.isFinite(days) || days <= 0) {
      return NextResponse.json(
        { error: "olderThanDays must be a positive number when deleteProjects is true." },
        { status: 400 },
      );
    }
    if (body.confirm !== "DELETE") {
      return NextResponse.json(
        { error: 'To delete projects, pass confirm: "DELETE".' },
        { status: 400 },
      );
    }

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    // Count first so the response reports exactly what was removed. Products
    // cascade via the schema's onDelete: Cascade, so deleting the project rows
    // is enough.
    const doomed = await prisma.project.findMany({
      where: { createdAt: { lt: cutoff } },
      select: { id: true, _count: { select: { products: true } } },
    });
    const productCount = doomed.reduce((n, p) => n + p._count.products, 0);

    const deleted = await prisma.project.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    result.projectsDeleted = deleted.count;
    result.productsDeleted = productCount;
    result.cutoff = cutoff.toISOString();
  }

  // 3. Reclaim disk so Render stops reporting the DB as full. Plain VACUUM (not
  //    FULL) — it runs without an exclusive table lock and returns free space to
  //    the OS on a bloated DB; VACUUM FULL would block the live app.
  await prisma.$executeRawUnsafe(`VACUUM;`);
  result.vacuumed = true;

  return NextResponse.json({ ok: true, ...result });
}
