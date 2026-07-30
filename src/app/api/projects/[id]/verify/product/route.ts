import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { verifyProducts, applyAiVerificationPasses } from "@/lib/marketplaces/verify";

/**
 * Re-verify a SINGLE product against the marketplace. This is the per-row
 * "Re-verify" action — the same pipeline the full run uses (marketplace lookup
 * + AI post-passes), scoped to one product so a reviewer can re-check an
 * individual SKU without re-running the whole catalog.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const { productId } = (await req.json().catch(() => ({}))) as { productId?: string };
  if (!productId) return NextResponse.json({ error: "productId is required" }, { status: 400 });

  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      marketplace: true,
      products: {
        where: { id: productId },
        select: {
          id: true,
          name: true,
          vendorSku: true,
          upc: true,
          asin: true,
          brand: true,
          price: true,
          description: true,
          imageUrl: true,
          verifyStatus: true,
          verifyFields: true,
          vendorData: true,
        },
      },
    },
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const product = project.products[0];
  if (!product) return NextResponse.json({ error: "Product not found in project" }, { status: 404 });

  const { withImageCache } = await import("@/lib/ai/compare-images");

  try {
    const [result] = await withImageCache(async () => {
      const results = await verifyProducts(
        project.marketplace,
        [product] as Parameters<typeof verifyProducts>[1],
        { skipAiPasses: true },
      );
      await applyAiVerificationPasses(
        results,
        [product] as Parameters<typeof applyAiVerificationPasses>[1],
        project.marketplace,
      );
      return results;
    });

    // A "skipped" result (e.g. Keepa tokens too low, transient outage) means we
    // never got a verdict — leave the product's stored status untouched.
    if (!result || result.status === "skipped") {
      return NextResponse.json(
        { error: "Could not verify this product right now — please try again in a moment.", skipped: true },
        { status: 503 },
      );
    }

    const ld = result.liveData as Record<string, unknown> | null;
    const verifiedAsin = typeof ld?.asin === "string" ? ld.asin : null;
    const verifiedPrice = typeof ld?.price === "number" && ld.price > 0 ? ld.price / 100 : null;
    const resolvedUpc = result.resolvedUpc ?? null;

    const updated = await prisma.product.update({
      where: { id: result.productId },
      data: {
        verifyStatus: result.status,
        verifyFields: result.fields as object[],
        liveData: result.liveData as object,
        verifiedAt: new Date(),
        ...(verifiedAsin ? { asin: verifiedAsin } : {}),
        ...(verifiedPrice ? { price: verifiedPrice } : {}),
        ...(resolvedUpc ? { upc: resolvedUpc } : {}),
      },
      select: {
        id: true,
        asin: true,
        upc: true,
        verifyStatus: true,
        verifyFields: true,
        verifiedAt: true,
      },
    });

    return NextResponse.json({ product: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Verification failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
