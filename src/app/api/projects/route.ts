import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { parseVendorFile } from "@/lib/vendor/parse";
import { recoverStaleProjects } from "@/lib/projects/recover-stale";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const { user, response } = await authGuard();
  if (response) return response;

  const form = await req.formData();
  const file = form.get("file") as File | null;
  const name = (form.get("name") as string | null)?.trim();
  const marketplace = form.get("marketplace") as string | null;
  // New-listing projects skip verification (no live page to check against).
  // Only meaningful for marketplaces that otherwise verify — currently Walmart.
  const isNewListing = form.get("isNewListing") === "true" && marketplace === "walmart";

  if (!file || !name || !marketplace) {
    return NextResponse.json({ error: "file, name and marketplace are required" }, { status: 400 });
  }

  const bytes = await file.arrayBuffer();
  console.log(`[upload] File: "${file.name}", size=${bytes.byteLength} bytes`);
  const { rows, parseInfo } = await parseVendorFile(Buffer.from(bytes), file.name);
  console.log(`[upload] parseVendorFile → ${rows.length} products for marketplace=${marketplace}`);
  console.log(`[upload] parseInfo: ${parseInfo}`);

  if (!rows.length) {
    return NextResponse.json({ error: "No rows found in the file" }, { status: 400 });
  }

  // Create the project first, then insert products in chunks.
  // Prisma nested create sends all rows as a single parameterised statement;
  // PostgreSQL's 65 535-parameter cap silently truncates files with 6 k+ products
  // (~11 cols × 6 k rows = 66 k params). Chunked createMany stays well under the limit.
  const project = await prisma.project.create({
    data: { userId: user!.id, name, marketplace, status: "uploaded", isNewListing },
  });

  // Insert sizing, learned the hard way against Render Postgres:
  //  - Rows carry the FULL vendor sheet as vendorData JSON (a 73-column file ≈ 4.5 KB/row),
  //    so a 2 000-row chunk is a ~9 MB statement.
  //  - Sequential 9 MB statements are proven safe; FOUR of them concurrently killed the
  //    server connection outright ("Client ... is not queryable") and lost the upload.
  //  - So: halve the chunk (≈4.5 MB) and allow only 2 in flight — the same ~9 MB peak
  //    the database has already demonstrated it can handle, at ~2× sequential speed.
  //  - Every chunk retries on transient/connection errors before the upload is failed.
  const CHUNK = 1000;
  const INSERT_CONCURRENCY = 2;
  const MAX_ATTEMPTS = 3;
  const chunks: (typeof rows)[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) chunks.push(rows.slice(i, i + CHUNK));

  let inserted = 0;
  let nextChunk = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(INSERT_CONCURRENCY, chunks.length) }, async () => {
        while (nextChunk < chunks.length) {
          const idx = nextChunk++;
          const chunk = chunks[idx];
          for (let attempt = 1; ; attempt++) {
            try {
              const result = await prisma.product.createMany({
                data: chunk.map((r) => ({
                  projectId: project.id,
                  name: r.name ?? "Unknown",
                  vendorSku: r.sku ?? null,
                  upc: r.upc ?? null,
                  asin: r.asin ?? null,
                  brand: r.brand ?? null,
                  description: r.description ?? null,
                  price: r.price ?? null,
                  imageUrl: r.imageUrl ?? null,
                  verifyStatus: r.discontinued === true ? "discontinued" : null,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  vendorData: r as any,
                })),
              });
              inserted += result.count;
              console.log(`[upload] Chunk ${idx + 1}/${chunks.length}: inserted ${result.count}/${chunk.length} (total so far: ${inserted})`);
              break;
            } catch (err) {
              if (attempt >= MAX_ATTEMPTS) throw err;
              console.warn(`[upload] Chunk ${idx + 1} attempt ${attempt} failed, retrying:`, err instanceof Error ? err.message : err);
              await new Promise((r) => setTimeout(r, 1500 * attempt));
            }
          }
        }
      }),
    );
  } catch (err) {
    // A chunk failed permanently — remove the partial project so the user doesn't end
    // up with a ghost "0 products" (or half-imported) project, and answer with real
    // JSON instead of a dead connection.
    console.error("[upload] Insert failed permanently, rolling back project:", err);
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    return NextResponse.json(
      { error: "Upload failed while saving products (database connection dropped). Nothing was imported — please try again." },
      { status: 500 },
    );
  }
  console.log(`[upload] Done: ${inserted}/${rows.length} products inserted for project ${project.id}`);

  return NextResponse.json({ id: project.id, count: inserted, parseInfo });
}

export async function DELETE(req: NextRequest) {
  const { user, response } = await authGuard();
  if (response) return response;

  const body = await req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return NextResponse.json({ error: "ids required" }, { status: 400 });

  // Only delete projects owned by the current user
  await prisma.project.deleteMany({
    where: { id: { in: ids }, userId: user!.id },
  });

  return NextResponse.json({ ok: true });
}

export async function GET() {
  const { user, response } = await authGuard();
  if (response) return response;

  await recoverStaleProjects({ userId: user!.id });

  const projects = await prisma.project.findMany({
    where: { userId: user!.id },
    include: { _count: { select: { products: true } } },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json(projects);
}
