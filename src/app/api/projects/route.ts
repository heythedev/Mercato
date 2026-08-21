import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { parseVendorFile } from "@/lib/vendor/parse";
import { recoverStaleProjects } from "@/lib/projects/recover-stale";
import { canUseMarketplace } from "@/lib/marketplaces/catalog";

export const maxDuration = 300;

// Parse inside a helper so the multi-MB upload buffer becomes unreachable —
// and collectable — as soon as parsing is done, instead of staying pinned in
// the request scope while the insert phase still has minutes of work ahead.
async function parseUpload(file: File) {
  const bytes = Buffer.from(await file.arrayBuffer());
  console.log(`[upload] File: "${file.name}", size=${bytes.byteLength} bytes`);
  return parseVendorFile(bytes, file.name);
}

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

  // Enforce marketplace access. Read role + allow-list fresh from the DB (the
  // session may predate an admin's access change) rather than trusting the JWT.
  const account = await prisma.user.findUnique({
    where: { id: user!.id },
    select: { role: true, allowedMarketplaces: true },
  });
  if (!account) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canUseMarketplace(marketplace, account)) {
    return NextResponse.json(
      { error: "You don't have access to create projects for this marketplace." },
      { status: 403 },
    );
  }

  const { rows, parseInfo } = await parseUpload(file);
  const totalRows = rows.length;
  console.log(`[upload] parseVendorFile → ${totalRows} products for marketplace=${marketplace}`);
  console.log(`[upload] parseInfo: ${parseInfo}`);

  if (!totalRows) {
    return NextResponse.json({ error: "No rows found in the file" }, { status: 400 });
  }

  // Create the project first, then insert products in chunks.
  // Prisma nested create sends all rows as a single parameterised statement;
  // PostgreSQL's 65 535-parameter cap silently truncates files with 6 k+ products
  // (~11 cols × 6 k rows = 66 k params). Chunked createMany stays well under the limit.
  //
  // Status starts as "uploading" and flips to "uploaded" only after every chunk
  // is in. The rollback in the catch below handles a thrown insert error, but an
  // OOM-killed process runs no catch — recoverStaleProjects deletes anything
  // stranded in "uploading", so a kill can't leave a half-imported project
  // masquerading as a complete one.
  const project = await prisma.project.create({
    data: { userId: user!.id, name, marketplace, status: "uploading", isNewListing },
  });

  // Insert sizing, learned the hard way against Render Postgres and revised for
  // the 512 MB instance + remote-region Supabase:
  //  - Rows carry the FULL vendor sheet as vendorData JSON (a 73-column file ≈ 4.5 KB/row),
  //    so a 1 000-row chunk is a ~4.5 MB statement.
  //  - One statement in flight at a time. Cross-region latency stretches each
  //    statement to several seconds, so two concurrent ~4.5 MB serializations
  //    held memory long enough to OOM-kill the process mid-upload on a 10k file.
  //  - Ownership of the parsed rows moves into `chunks`, and each chunk is
  //    released as soon as it is inserted, so peak memory falls as the upload
  //    progresses instead of holding all 10k rows until the response.
  //  - Every chunk retries on transient/connection errors before the upload is failed.
  const CHUNK = 1000;
  const MAX_ATTEMPTS = 3;
  const chunks: (typeof rows | null)[] = [];
  while (rows.length) chunks.push(rows.splice(0, CHUNK));

  let inserted = 0;
  try {
    for (let idx = 0; idx < chunks.length; idx++) {
      const chunk = chunks[idx]!;
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
          chunks[idx] = null; // inserted — release these rows to the GC
          console.log(`[upload] Chunk ${idx + 1}/${chunks.length}: inserted ${result.count}/${chunk.length} (total so far: ${inserted})`);
          break;
        } catch (err) {
          if (attempt >= MAX_ATTEMPTS) throw err;
          console.warn(`[upload] Chunk ${idx + 1} attempt ${attempt} failed, retrying:`, err instanceof Error ? err.message : err);
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    }
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
  await prisma.project.update({
    where: { id: project.id },
    data: { status: "uploaded" },
  });
  console.log(`[upload] Done: ${inserted}/${totalRows} products inserted for project ${project.id}`);

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

  try {
    await recoverStaleProjects({ userId: user!.id });

    const projects = await prisma.project.findMany({
      where: { userId: user!.id },
      include: { _count: { select: { products: true } } },
      orderBy: { updatedAt: "desc" },
    });

    return NextResponse.json(projects);
  } catch (err) {
    // Surface the DB error instead of crashing into an empty-body 500 — the
    // message names the failure (pool exhaustion, timeout, …), which platform
    // logs on cold instances routinely swallow.
    const msg = err instanceof Error ? err.message : "Failed to load projects";
    console.error("[projects] GET failed:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
