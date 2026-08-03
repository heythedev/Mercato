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
  const rows = await parseVendorFile(Buffer.from(bytes), file.name);
  console.log(`[upload] parseVendorFile → ${rows.length} products for marketplace=${marketplace}`);

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

  // 11 columns × 2 000 rows = 22 000 params — well under PostgreSQL's 65 535 limit.
  // Fewer round trips means faster completion and lower timeout risk on large files.
  const CHUNK = 2000;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
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
    console.log(`[upload] Chunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(rows.length / CHUNK)}: inserted ${result.count}/${chunk.length} (total so far: ${inserted})`);
  }
  console.log(`[upload] Done: ${inserted}/${rows.length} products inserted for project ${project.id}`);

  return NextResponse.json({ id: project.id, count: inserted });
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
