import { NextRequest, NextResponse } from "next/server";
import { actorOf, canOperateProject } from "@/lib/authz";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const body = await req.json();
  const { verifyStatus } = body as { verifyStatus?: string };

  const allowed = ["ok", "warning", "mismatch", "not_found", "discontinued"];
  if (!verifyStatus || !allowed.includes(verifyStatus)) {
    return NextResponse.json({ error: "Invalid verifyStatus" }, { status: 400 });
  }

  // Verify the product belongs to this user
  const product = await prisma.product.findUnique({
    where: { id },
    include: { project: { select: { userId: true } } },
  });

  if (!product) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!canOperateProject(actorOf(user), product.project)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  await prisma.product.update({
    where: { id },
    data: { verifyStatus },
  });

  return NextResponse.json({ ok: true });
}
