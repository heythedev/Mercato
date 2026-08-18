import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";

// One page of a project's product list. The project page used to load the
// entire catalog inside its server render; at 10k products that single
// payload (verifyFields JSON included on every row) was enough to kill the
// 512 MB instance mid-response. The client now pulls the catalog through
// this endpoint in pages small enough that no single request can hurt.
const MAX_LIMIT = 500;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const project = await prisma.project.findUnique({ where: { id }, select: { userId: true } });
  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Admins can open any project page, so they must be able to load its rows too.
  const isAdmin = (user as { role?: string }).role === "admin";
  if (project.userId !== user!.id && !isAdmin) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit")) || MAX_LIMIT));
  const cursor = sp.get("cursor");

  // cuids are generated in insert order, so `id asc` reproduces the vendor
  // file's row order — and unlike createdAt (identical across a whole
  // createMany chunk) the id is unique, which makes the cursor unambiguous.
  const products = await prisma.product.findMany({
    where: { projectId: id, ...(cursor ? { id: { gt: cursor } } : {}) },
    orderBy: { id: "asc" },
    take: limit,
    select: {
      id: true, name: true, vendorSku: true, upc: true, asin: true,
      brand: true, price: true, imageUrl: true, verifyStatus: true,
      verifyFields: true, marketplaceCategory: true, categoryPath: true,
      categorizedAt: true, verifiedAt: true,
    },
  });

  return NextResponse.json({
    products,
    nextCursor: products.length === limit ? products[products.length - 1].id : null,
  });
}
