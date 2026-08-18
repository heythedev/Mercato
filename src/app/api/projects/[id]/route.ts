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

  // No products in this payload — serializing the whole catalog into one JSON
  // response has the same 512 MB failure mode as the old server render did.
  // The client loads rows in pages from /api/projects/[id]/products instead.
  const project = await prisma.project.findUnique({
    where: { id },
    include: { _count: { select: { products: true } } },
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Admins can open any project page, so the refresh call must not 403 them.
  const isAdmin = (user as { role?: string }).role === "admin";
  if (project.userId !== user!.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
    productCount: project._count.products,
  });
}
