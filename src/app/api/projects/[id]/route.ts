import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { recoverStaleProjects } from "@/lib/projects/recover-stale";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  await prisma.project.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  await recoverStaleProjects({ id });

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      products: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true, name: true, vendorSku: true, upc: true, asin: true,
          brand: true, price: true, imageUrl: true, verifyStatus: true,
          verifyFields: true, marketplaceCategory: true, categoryPath: true,
          categorizedAt: true, verifiedAt: true,
        },
      },
    },
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  return NextResponse.json({
    project: {
      id: project.id,
      name: project.name,
      marketplace: project.marketplace,
      status: project.status,
      isNewListing: project.isNewListing,
      verifyMs: project.verifyMs,
      verifyCompletedAt: project.verifyCompletedAt,
      categorizeMs: project.categorizeMs,
      categorizeCompletedAt: project.categorizeCompletedAt,
    },
    products: project.products,
  });
}
