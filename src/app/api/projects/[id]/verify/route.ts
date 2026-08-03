import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { verifyProducts, applyAiVerificationPasses } from "@/lib/marketplaces/verify";
import {
  estimateAmazonVerifyTokens,
  refreshKeepaTokens,
} from "@/lib/keepa/client";

const BATCH_SIZE = 50;

// Stop starting new batches once we're this close to the `maxDuration` ceiling.
// A run that is cut off mid-batch loses that batch's work and strands the
// project; stopping cleanly lets the caller resume from where we left off.
const TIME_BUDGET_MS = (maxDuration - 45) * 1000;

// Reserve the last 90 seconds for the combined AI post-pass that runs ONCE
// after all marketplace-API batches complete (instead of once per batch).
// This lets Walmart process ~800+ products per run instead of ~100.
const LOOKUP_BUDGET_MS = TIME_BUDGET_MS - 90_000;

function isAmazonMarketplace(marketplace: string): boolean {
  return marketplace === "amazon" || marketplace === "amazon_us";
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { user, response } = await authGuard();
  if (response) return response;
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      marketplace: true,
      verifyMs: true,
      verifyCompletedAt: true,
      products: {
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

  // Resume by default: only products that were never verified are processed, so
  // a run cut short by the duration ceiling can be continued by calling again.
  // `?force=1` re-checks everything (the explicit "Re-verify" action).
  const force = _req.nextUrl.searchParams.get("force") === "1";
  const allProducts = force
    ? project.products
    : project.products.filter((p) => p.verifyStatus == null);

  // A fresh run (explicit re-verify, or nothing verified yet) resets the timer;
  // a resume ("Continue") adds this pass onto the accumulated time.
  const isFreshStart = force || project.products.every((p) => p.verifyStatus == null);
  const priorMs = isFreshStart ? 0 : (project.verifyMs ?? 0);

  // Nothing left to do — the project is already fully verified.
  if (allProducts.length === 0) {
    await prisma.project.update({
      where: { id },
      data: {
        status: "verified",
        // Stamp a completion time if one was never recorded (e.g. legacy runs).
        ...(project.verifyCompletedAt == null ? { verifyCompletedAt: new Date() } : {}),
      },
    });
    return NextResponse.json({
      verified: 0,
      skipped: 0,
      remaining: 0,
      complete: true,
      totalProducts: project.products.length,
    });
  }

  // Preflight: Amazon verify needs enough Keepa tokens for the estimate before starting.
  if (isAmazonMarketplace(project.marketplace) && allProducts.length > 0) {
    const { estimated, required } = estimateAmazonVerifyTokens(allProducts.length);
    const tokenInfo = await refreshKeepaTokens();
    const tokensLeft = tokenInfo?.tokensLeft ?? 0;

    if (tokensLeft < required) {
      const refillRate = tokenInfo?.refillRate ?? 0;
      const shortfall = required - tokensLeft;
      const waitMins = refillRate > 0 ? Math.ceil(shortfall / refillRate) : null;
      const waitHint = waitMins != null
        ? ` Tokens refill at ${refillRate}/min — try again in about ${waitMins} minute${waitMins === 1 ? "" : "s"}.`
        : "";

      return NextResponse.json(
        {
          error: `Not enough Keepa tokens available to verify. Need ${required.toLocaleString()} tokens, but only ${tokensLeft.toLocaleString()} available.${waitHint}`,
          code: "INSUFFICIENT_KEEPA_TOKENS",
          tokensLeft,
          estimated,
          required,
          refillRate,
        },
        { status: 429 },
      );
    }
  }

  await prisma.project.update({
    where: { id },
    data: {
      status: "verifying",
      // On a fresh run clear the previous timing so it accumulates from zero.
      ...(isFreshStart ? { verifyMs: 0, verifyCompletedAt: null } : {}),
    },
  });

  let totalProcessed = 0;
  let totalSkipped = 0;
  let attempted = 0;
  let ranOutOfTime = false;

  // Accumulate results from all batches so the AI post-pass runs once at the end.
  const allRawResults: Awaited<ReturnType<typeof verifyProducts>> = [];
  const allAttemptedProducts: typeof allProducts = [];

  // One download cache for the whole run: vendor images are compared against
  // several marketplace angles, and marketplace CDN URLs recur across products,
  // so this removes most of the repeated image-fetch I/O.
  const { withImageCache } = await import("@/lib/ai/compare-images");

  try {
    await withImageCache(async () => {
      for (let i = 0; i < allProducts.length; i += BATCH_SIZE) {
        // Reserve time for the combined AI post-pass by cutting off new batches
        // at LOOKUP_BUDGET_MS instead of the full TIME_BUDGET_MS.
        if (Date.now() - startedAt > LOOKUP_BUDGET_MS) {
          ranOutOfTime = true;
          break;
        }
        const batch = allProducts.slice(i, i + BATCH_SIZE);
        attempted += batch.length;

        // Skip AI passes here — they run once after all batches below.
        const results = await verifyProducts(
          project.marketplace,
          batch as Parameters<typeof verifyProducts>[1],
          { skipAiPasses: true },
        );

        const processed = results.filter((r) => r.status !== "skipped");
        totalSkipped += results.length - processed.length;

        // Save base results immediately so progress is preserved even if the
        // AI pass below runs out of time.
        for (let j = 0; j < processed.length; j += 10) {
          const sub = processed.slice(j, j + 10);
          await Promise.all(
            sub.map((r) => {
              const ld = r.liveData as Record<string, unknown> | null;
              const verifiedAsin = typeof ld?.asin === "string" ? ld.asin : null;
              // Keepa prices are in cents (e.g. 1999 = $19.99)
              const verifiedPrice = typeof ld?.price === "number" && ld.price > 0
                ? ld.price / 100 : null;
              // Save UPC resolved from vendorData scan when p.upc was missing
              const resolvedUpc = r.resolvedUpc ?? null;
              return prisma.product.update({
                where: { id: r.productId },
                data: {
                  verifyStatus: r.status,
                  verifyFields: r.fields as object[],
                  liveData: r.liveData as object,
                  verifiedAt: new Date(),
                  ...(verifiedAsin ? { asin: verifiedAsin } : {}),
                  ...(verifiedPrice ? { price: verifiedPrice } : {}),
                  ...(resolvedUpc ? { upc: resolvedUpc } : {}),
                },
              });
            })
          );
        }

        totalProcessed += processed.length;
        allRawResults.push(...results);
        allAttemptedProducts.push(...batch);
      }
    });

    // Single combined AI post-pass on all gathered results.
    // Previously this ran inside each batch (~60-90s/batch × 22 batches for 1100
    // products = budget exhausted after 2 batches). Now it runs once here.
    if (allRawResults.length > 0) {
      await applyAiVerificationPasses(
        allRawResults,
        allAttemptedProducts as Parameters<typeof applyAiVerificationPasses>[1],
        project.marketplace,
      );

      // Persist the AI-updated status and field annotations.
      // liveData / asin / price / upc were already saved in the batch loop above.
      const aiProcessed = allRawResults.filter((r) => r.status !== "skipped");
      for (let j = 0; j < aiProcessed.length; j += 10) {
        const sub = aiProcessed.slice(j, j + 10);
        await Promise.all(
          sub.map((r) =>
            prisma.product.update({
              where: { id: r.productId },
              data: {
                verifyStatus: r.status,
                verifyFields: r.fields as object[],
              },
            })
          )
        );
      }
    }

    const remaining = allProducts.length - attempted;
    const complete = remaining === 0;

    // Active time of this pass, accumulated onto prior passes. Idle gaps between
    // "Continue" clicks are not counted — only time spent inside a POST.
    const accumulatedMs = priorMs + (Date.now() - startedAt);

    // Only claim "verified" once every product has actually been checked;
    // otherwise leave the project resumable rather than falsely complete.
    await prisma.project.update({
      where: { id },
      data: {
        status: complete ? "verified" : "uploaded",
        verifyMs: accumulatedMs,
        ...(complete ? { verifyCompletedAt: new Date() } : {}),
      },
    });

    return NextResponse.json({
      verified: totalProcessed,
      skipped: totalSkipped,
      remaining,
      complete,
      partial: ranOutOfTime,
      totalProducts: project.products.length,
    });
  } catch (err) {
    // Work already committed to the DB is preserved; the project drops back to
    // "uploaded" so the next call resumes with whatever is still unverified.
    // Keep the time spent so far so the accumulator stays accurate on resume.
    await prisma.project.update({
      where: { id },
      data: { status: "uploaded", verifyMs: priorMs + (Date.now() - startedAt) },
    });
    const msg = err instanceof Error ? err.message : "Verification failed";
    return NextResponse.json(
      { error: msg, verified: totalProcessed, resumable: true },
      { status: 500 },
    );
  }
}
