import { NextRequest, NextResponse } from "next/server";

// The app is self-hosted (`next start`), so this is our own ceiling rather than
// a platform limit. A 10k-product Walmart run is the sizing target; 15 minutes
// leaves headroom above the ~10 minute expected duration without letting a
// genuinely stuck run hold a connection indefinitely.
export const maxDuration = 900;
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import {
  verifyProducts,
  applyAiVerificationPasses,
  resetWalmartRunState,
} from "@/lib/marketplaces/verify";
import {
  estimateAmazonVerifyTokens,
  refreshKeepaTokens,
} from "@/lib/keepa/client";

// Products per lookup batch. The limiter — not this number — governs API
// concurrency, but each batch is a barrier: the next one cannot start until the
// slowest product in this one finishes. With concurrency ~96 a small batch
// drains almost as fast as it fills, so the run spends a large fraction of its
// time in barrier stalls. 1000 keeps the pool saturated between barriers while
// still committing progress often enough to survive the time ceiling.
const BATCH_SIZE = 1000;

// Stop starting new batches once we're this close to the `maxDuration` ceiling.
// A run that is cut off mid-batch loses that batch's work and strands the
// project; stopping cleanly lets the caller resume from where we left off.
const TIME_BUDGET_MS = (maxDuration - 45) * 1000;

// Reserve time for the AI post-pass, but only when it is actually going to run.
// With AI off (the default) the entire budget goes to lookups.
const AI_RESERVE_MS = 120_000;

function isAmazonMarketplace(marketplace: string): boolean {
  return marketplace === "amazon" || marketplace === "amazon_us";
}

/**
 * True when a result has two images that nothing has actually compared.
 *
 * Selecting AI targets by product status alone is not enough: an unchecked
 * images row is reported as "ok" (a warning must mean something looks wrong,
 * not that we didn't look), so these products are "ok" overall and would be
 * filtered out before the AI pass ever saw them — which is precisely the case
 * the deep check exists to resolve.
 */
function needsImageCheck(r: { fields: unknown }): boolean {
  const fields = (r.fields ?? []) as Array<{ field: string; note?: string; liveImage?: string; stored?: string }>;
  const img = fields.find((f) => f.field === "images");
  if (!img) return false;
  return (
    !!img.stored?.startsWith("http") &&
    !!img.liveImage?.startsWith("http") &&
    // The note the comparison-less path sets; an AI verdict replaces it.
    !!img.note?.startsWith("Images not compared")
  );
}

/**
 * Product updates in flight at any one time.
 *
 * These are deliberately NOT wrapped in a transaction. Each row is independent,
 * so all-or-nothing semantics would mean one bad row discarding hundreds of
 * successfully verified products — which the resume pass would then have to
 * re-fetch from Walmart. Batching them into a single `$transaction` also blew
 * past Prisma's 5s interactive-transaction timeout at this volume.
 *
 * Capped at 8 to stay under the node-postgres pool (10 connections by default).
 * Exceeding the pool doesn't just queue — it fails with "timeout exceeded when
 * trying to connect" once the wait passes `connectionTimeoutMillis`, which is
 * the same failure `inChunks` in src/lib/db.ts was introduced to prevent.
 */
const WRITE_CONCURRENCY = 8;

type PersistableResult = {
  productId: string;
  status: string;
  fields: unknown;
  liveData?: unknown;
  resolvedUpc?: string;
};

/** Rows per bulk statement. Keeps the parameter count well under Postgres' 65535 cap. */
const BULK_CHUNK = 500;

/**
 * Update many products in a single statement using UPDATE ... FROM (VALUES ...).
 *
 * Prisma has no bulk-update-with-distinct-values primitive: `updateMany` applies
 * one identical payload to every matched row, which is not what verification
 * needs. Issuing N individual updates instead costs N network round-trips —
 * ~7 minutes for 10k rows against a remote database.
 *
 * Values are passed as query parameters (never interpolated), and COALESCE
 * preserves the existing column when a row has no new value, matching the
 * conditional-spread semantics of the per-row path.
 */
async function bulkUpdateProducts(
  results: PersistableResult[],
  opts: { statusAndFieldsOnly?: boolean; verifiedAt: Date },
): Promise<void> {
  for (let i = 0; i < results.length; i += BULK_CHUNK) {
    const chunk = results.slice(i, i + BULK_CHUNK);
    const params: unknown[] = [];
    const tuples: string[] = [];

    for (const r of chunk) {
      const ld = r.liveData as Record<string, unknown> | null;
      const asin = typeof ld?.asin === "string" ? ld.asin : null;
      // Keepa prices are in cents (e.g. 1999 = $19.99)
      const price = typeof ld?.price === "number" && ld.price > 0 ? ld.price / 100 : null;

      const n = params.length;
      if (opts.statusAndFieldsOnly) {
        params.push(r.productId, r.status, JSON.stringify(r.fields ?? []));
        tuples.push(`($${n + 1}::text, $${n + 2}::text, $${n + 3}::jsonb)`);
      } else {
        params.push(
          r.productId,
          r.status,
          JSON.stringify(r.fields ?? []),
          JSON.stringify(r.liveData ?? {}),
          asin,
          price,
          r.resolvedUpc ?? null,
        );
        tuples.push(
          `($${n + 1}::text, $${n + 2}::text, $${n + 3}::jsonb, $${n + 4}::jsonb, ` +
            `$${n + 5}::text, $${n + 6}::double precision, $${n + 7}::text)`,
        );
      }
    }

    const sql = opts.statusAndFieldsOnly
      ? `UPDATE "Product" AS p
         SET "verifyStatus" = v.status,
             "verifyFields" = v.fields
         FROM (VALUES ${tuples.join(",")}) AS v(id, status, fields)
         WHERE p.id = v.id`
      : `UPDATE "Product" AS p
         SET "verifyStatus" = v.status,
             "verifyFields" = v.fields,
             "liveData"     = v.livedata,
             "verifiedAt"   = $${params.length + 1}::timestamp,
             "asin"         = COALESCE(v.asin, p."asin"),
             "price"        = COALESCE(v.price, p."price"),
             "upc"          = COALESCE(v.upc, p."upc")
         FROM (VALUES ${tuples.join(",")}) AS v(id, status, fields, livedata, asin, price, upc)
         WHERE p.id = v.id`;

    if (!opts.statusAndFieldsOnly) params.push(opts.verifiedAt);
    await prisma.$executeRawUnsafe(sql, ...params);
  }
}

/**
 * Write verification results back to the products table.
 *
 * Each row gets distinct values, so this is inherently N updates. They are
 * issued with bounded concurrency rather than one-at-a-time: at 10k products the
 * original shape (chunks of 10, awaited serially) spent minutes purely on
 * round-trip latency.
 *
 * A failed row is logged and skipped rather than aborting the run — it simply
 * stays unverified, and the resume pass picks it up.
 *
 * `statusAndFieldsOnly` is for the AI re-persist, where liveData/asin/price/upc
 * were already committed by the lookup pass and must not be rewritten.
 */
async function persistResults(
  results: PersistableResult[],
  opts?: { statusAndFieldsOnly?: boolean },
): Promise<void> {
  if (!results.length) return;
  const verifiedAt = new Date();
  let failed = 0;

  const writeOne = (r: PersistableResult) => {
    if (opts?.statusAndFieldsOnly) {
      return prisma.product.update({
        where: { id: r.productId },
        data: {
          verifyStatus: r.status,
          verifyFields: r.fields as object[],
        },
      });
    }
    const ld = r.liveData as Record<string, unknown> | null;
    const verifiedAsin = typeof ld?.asin === "string" ? ld.asin : null;
    // Keepa prices are in cents (e.g. 1999 = $19.99)
    const verifiedPrice =
      typeof ld?.price === "number" && ld.price > 0 ? ld.price / 100 : null;
    // Save UPC resolved from vendorData scan when p.upc was missing
    const resolvedUpc = r.resolvedUpc ?? null;
    return prisma.product.update({
      where: { id: r.productId },
      data: {
        verifyStatus: r.status,
        verifyFields: r.fields as object[],
        liveData: r.liveData as object,
        verifiedAt,
        ...(verifiedAsin ? { asin: verifiedAsin } : {}),
        ...(verifiedPrice ? { price: verifiedPrice } : {}),
        ...(resolvedUpc ? { upc: resolvedUpc } : {}),
      },
    });
  };

  // Fast path: one bulk UPDATE ... FROM (VALUES ...) per chunk instead of one
  // round-trip per row. Against a remote database (~40ms RTT) per-row updates
  // cost ~7 minutes for 10k products — more than the entire lookup phase — so
  // this is what keeps a full catalog run inside its time budget.
  try {
    await bulkUpdateProducts(results, { statusAndFieldsOnly: opts?.statusAndFieldsOnly, verifiedAt });
    return;
  } catch (e) {
    console.error(
      "[verify-persist] bulk update failed, falling back to per-row writes:",
      e instanceof Error ? e.message : e,
    );
  }

  // Fallback: per-row writes with bounded concurrency. Slower, but keeps a run
  // working if the bulk statement ever hits something it can't express.
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= results.length) return;
      try {
        await writeOne(results[i]);
      } catch (e) {
        failed++;
        if (failed <= 3) {
          console.error(
            `[verify-persist] product ${results[i].productId} failed to save:`,
            e instanceof Error ? e.message : e,
          );
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(WRITE_CONCURRENCY, results.length) }, worker),
  );

  if (failed) {
    console.error(
      `[verify-persist] ${failed}/${results.length} product writes failed — ` +
        `those products stay unverified and will be retried on resume`,
    );
  }
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
  // AI image/title adjudication costs a model call per product and dominates the
  // run at catalog scale, so it is opt-in via `?ai=1`. When enabled it only
  // examines flagged (warning/mismatch) results — a clean barcode-confirmed
  // match gains nothing from a vision check.
  const useAi = _req.nextUrl.searchParams.get("ai") === "1";

  // A forced re-verify starts this run's progress from ZERO: clear the previous
  // run's verdicts server-side (the client already clears them visually). Without
  // this, old `verifiedAt` timestamps make the live progress feed report the run
  // as ~100% checked the moment it starts, and — worse — the follow-up resume
  // passes (which select `verifyStatus == null`) would skip every product still
  // carrying a stale status from the prior run. Discontinued flags are kept:
  // they can originate from the vendor sheet, not verification, and would not be
  // re-derived by this run.
  if (force && project.products.length > 0) {
    await prisma.product.updateMany({
      where: { projectId: id, NOT: { verifyStatus: "discontinued" } },
      data: { verifiedAt: null, verifyStatus: null, verifyFields: Prisma.DbNull },
    });
  }
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

  // Accumulate only the flagged results (and their matching products) so the AI
  // post-pass can run once at the end. Holding every result — each carries a full
  // raw `liveData` blob — for a 10k-product run exhausts the heap (OOM crash), and
  // the AI pass is `onlyFlagged` anyway, so non-flagged rows are never needed here.
  const flaggedResults: Awaited<ReturnType<typeof verifyProducts>> = [];
  const flaggedProducts: typeof allProducts = [];

  // One download cache for the whole run: vendor images are compared against
  // several marketplace angles, and marketplace CDN URLs recur across products,
  // so this removes most of the repeated image-fetch I/O.
  const { withImageCache } = await import("@/lib/ai/compare-images");

  // When the AI pass is off, lookups get the whole budget.
  const lookupBudgetMs = useAi ? TIME_BUDGET_MS - AI_RESERVE_MS : TIME_BUDGET_MS;

  // A fresh run re-probes the seller catalog; a resume keeps the decision the
  // earlier pass already paid to make.
  if (isFreshStart) resetWalmartRunState();

  try {
    await withImageCache(async () => {
      for (let i = 0; i < allProducts.length; i += BATCH_SIZE) {
        if (Date.now() - startedAt > lookupBudgetMs) {
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

        // Persist the batch. Progress is committed per batch so a run cut short
        // by the time ceiling keeps everything it already resolved.
        await persistResults(processed);

        totalProcessed += processed.length;

        // Retain only what the end-of-run AI pass will actually look at. This
        // keeps peak memory bounded by the number of problems found rather than
        // by catalog size, so a large run no longer OOMs.
        if (useAi) {
          const flaggedInBatch = results.filter(
            (r) => r.status === "warning" || r.status === "mismatch" || needsImageCheck(r),
          );
          if (flaggedInBatch.length) {
            const ids = new Set(flaggedInBatch.map((r) => r.productId));
            flaggedResults.push(...flaggedInBatch);
            flaggedProducts.push(...batch.filter((p) => ids.has(p.id)));
          }
        }
      }
    });

    // Optional AI post-pass, once over all gathered results (never per batch).
    // Restricted to flagged results, so its cost scales with the number of
    // problems found rather than with catalog size.
    if (useAi && flaggedResults.length > 0) {
      await applyAiVerificationPasses(
        flaggedResults,
        flaggedProducts as Parameters<typeof applyAiVerificationPasses>[1],
        project.marketplace,
        { onlyFlagged: true },
      );
      // Re-persist only the rows the AI pass could have changed. liveData / asin
      // / price / upc were already written in the batch loop and don't change.
      await persistResults(
        flaggedResults.filter((r) => r.status !== "skipped"),
        { statusAndFieldsOnly: true },
      );
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
