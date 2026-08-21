import { NextRequest, NextResponse } from "next/server";

// Vercel's Hobby-plan ceiling (Pro allows 800). A full 10k-product run takes
// ~10 minutes, so it no longer fits one request — the time budget below stops
// cleanly before the ceiling and the caller resumes, taking a few round-trips
// per run instead of one.
export const maxDuration = 300;
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

// Products per lookup batch — also the page size for streaming rows out of the
// database. Each batch is the unit of both progress and memory: rows are
// fetched (with their multi-KB vendorData blobs), verified, persisted, then
// released, so peak memory is bounded by this number instead of catalog size.
// The 512 MB production instance is the sizing constraint here. The limiter
// (~100 concurrent calls) still saturates within a 500-row batch; the extra
// barrier stalls vs. the old 1000 cost seconds over a full run, where loading
// the whole catalog up front cost hundreds of MB.
const BATCH_SIZE = 500;

// Amazon runs use a much smaller page. An Amazon batch resolves through
// Synccentric (sequential groups of 10) plus a Keepa fallback, so a 500-row
// batch can run for minutes before its persist — an OOM kill mid-batch then
// loses every lookup in it, re-burns the same Synccentric quota on retry, and
// strands the project in "verifying". 100 rows commits progress often enough
// that a killed instance costs one small batch, and it bounds the in-flight
// vendor/lookup payloads held in memory at any moment.
const AMAZON_BATCH_SIZE = 100;

// Flagged rows adjudicated (and re-persisted) per AI slice. Bounds the AI
// pass's working set and the work lost if a long pass is interrupted: each
// slice's verdicts are committed before the next slice starts.
const AI_CHUNK = 100;

// Only run the AI post-pass INSIDE this request when the flagged set is small.
// Each flagged product costs a multi-second vision call; at catalog scale that
// adds up to tens of minutes inside a single HTTP request — Render's proxy
// gives up long before that and kills the connection, so the browser reports a
// failed verify even though every lookup was already persisted. Larger sets
// keep their "not compared" markers and are worked through by the background
// image sweep (POST /verify/images) in short, resumable chunks instead.
const AI_INLINE_MAX = 50;

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
 * images row shows as "warning" but the product can still be "ok" overall
 * (images are a soft field pre-AI). Filtering on status alone would miss these
 * products; the note text "not compared" is the reliable marker.
 */
function needsImageCheck(r: { fields: unknown }): boolean {
  const fields = (r.fields ?? []) as Array<{ field: string; note?: string; liveImage?: string; stored?: string }>;
  const img = fields.find((f) => f.field === "images");
  if (!img) return false;
  return (
    !!img.stored?.startsWith("http") &&
    !!img.liveImage?.startsWith("http") &&
    // The note the comparison-less path sets; an AI verdict replaces it.
    // Two variants: UPC-confirmed ("Product identity confirmed … images not compared.")
    // and non-confirmed ("Images not compared — verify manually…"). Both contain "not compared".
    !!img.note?.includes("not compared")
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
    },
  });

  if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (project.userId !== user!.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Resume by default: only products that were never verified are processed, so
  // a run cut short by the duration ceiling can be continued by calling again.
  // `?force=1` re-checks everything (the explicit "Re-verify" action).
  const force = _req.nextUrl.searchParams.get("force") === "1";
  // AI image/title adjudication runs by default on every verify pass. It only
  // examines flagged (warning/mismatch) results and products whose images have
  // not been compared — a clean barcode-confirmed match gains nothing from a
  // vision check so it is skipped. Pass `?ai=0` to disable it explicitly.
  const useAi = _req.nextUrl.searchParams.get("ai") !== "0";

  // Peak memory must stay bounded regardless of catalog size, so products are
  // never loaded wholesale — this route works from counts here plus
  // BATCH_SIZE-row pages streamed out of the database in the loop below.
  const totalProducts = await prisma.product.count({ where: { projectId: id } });
  const verifiedBefore = await prisma.product.count({
    where: { projectId: id, verifyStatus: { not: null } },
  });

  // A fresh run (explicit re-verify, or nothing verified yet) resets the timer;
  // a resume ("Continue") adds this pass onto the accumulated time.
  const isFreshStart = force || verifiedBefore === 0;
  const priorMs = isFreshStart ? 0 : (project.verifyMs ?? 0);

  // A forced re-verify starts this run's progress from ZERO: clear the previous
  // run's verdicts server-side (the client already clears them visually). Without
  // this, old `verifiedAt` timestamps make the live progress feed report the run
  // as ~100% checked the moment it starts, and — worse — the follow-up resume
  // passes (which select `verifyStatus == null`) would skip every product still
  // carrying a stale status from the prior run. Discontinued flags are kept:
  // they can originate from the vendor sheet, not verification, and would not be
  // re-derived by this run.
  if (force && totalProducts > 0) {
    await prisma.product.updateMany({
      where: { projectId: id, NOT: { verifyStatus: "discontinued" } },
      data: { verifiedAt: null, verifyStatus: null, verifyFields: Prisma.DbNull },
    });
  }

  // What this pass has to cover: every row never verified (or just cleared by
  // force). Rows already marked discontinued keep that flag and are not
  // re-checked — the force-clear above deliberately preserves them, and a
  // re-check would only re-derive the same verdict from the vendor sheet.
  const pendingWhere = { projectId: id, verifyStatus: null } as const;
  const pendingTotal = await prisma.product.count({ where: pendingWhere });

  // Nothing left to do — the project is already fully verified.
  if (pendingTotal === 0) {
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
      totalProducts,
    });
  }

  // Preflight: Amazon verify needs enough Keepa tokens for the estimate before starting.
  // With Synccentric configured the shortage is survivable — Keepa does what it
  // can afford and the fallback source resolves the rest — so the run proceeds.
  if (isAmazonMarketplace(project.marketplace)) {
    const { estimated, required } = estimateAmazonVerifyTokens(pendingTotal);
    const tokenInfo = await refreshKeepaTokens();
    const tokensLeft = tokenInfo?.tokensLeft ?? 0;
    const { synccentricConfigured } = await import("@/lib/synccentric/client");

    if (tokensLeft < required && synccentricConfigured()) {
      console.log(
        `[keepa-tokens] short ${required - tokensLeft} of ${required} needed — ` +
          `proceeding with Synccentric fallback`,
      );
    } else if (tokensLeft < required) {
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

  // Accumulate only the flagged results for the AI post-pass — and only the
  // parts of them the passes actually read. A full VerifyResult drags its raw
  // liveData blob along, and the matching product row its vendorData blob; at
  // 10k-catalog scale holding those for every flagged row exhausts the heap
  // (OOM crash). The passes need the fields (mutated in place, so shared by
  // reference), the live image URLs, and the product name — nothing else.
  const flaggedResults: Awaited<ReturnType<typeof verifyProducts>> = [];
  const flaggedNames: Array<{ id: string; name: string }> = [];

  // One download cache for the whole run: vendor images are compared against
  // several marketplace angles, and marketplace CDN URLs recur across products,
  // so this removes most of the repeated image-fetch I/O.
  const { withImageCache } = await import("@/lib/ai/compare-images");

  // When the AI pass is off, lookups get the whole budget.
  const lookupBudgetMs = useAi ? TIME_BUDGET_MS - AI_RESERVE_MS : TIME_BUDGET_MS;

  // A fresh run re-probes the seller catalog; a resume keeps the decision the
  // earlier pass already paid to make.
  if (isFreshStart) resetWalmartRunState();

  const batchSize = isAmazonMarketplace(project.marketplace) ? AMAZON_BATCH_SIZE : BATCH_SIZE;

  try {
    await withImageCache(async () => {
      // Stream unverified rows in id order. Persisting a row sets its
      // verifyStatus, but "skipped" rows keep NULL (they were never resolved),
      // so the cursor — not the NULL filter — is what guarantees forward
      // progress within this pass. A later pass retries the skipped rows.
      let cursor: string | null = null;
      for (;;) {
        if (Date.now() - startedAt > lookupBudgetMs) {
          ranOutOfTime = true;
          break;
        }
        const where: Prisma.ProductWhereInput = cursor
          ? { ...pendingWhere, id: { gt: cursor } }
          : { ...pendingWhere };
        const batch = await prisma.product.findMany({
          where,
          orderBy: { id: "asc" },
          take: batchSize,
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
        });
        if (batch.length === 0) break;
        cursor = batch[batch.length - 1].id;
        attempted += batch.length;

        // Skip AI passes here — they run over the flagged rows below.
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

        // Retain slim copies of what the AI pass will look at: same `fields`
        // array by reference (the pass mutates it, the re-persist reads it),
        // liveData pared down to the image URLs the comparison needs.
        if (useAi) {
          const nameById = new Map(batch.map((b) => [b.id, b.name]));
          for (const r of results) {
            if (r.status !== "warning" && r.status !== "mismatch" && !needsImageCheck(r)) continue;
            const liveImages = Array.isArray(r.liveData?.images) ? (r.liveData.images as unknown[]) : [];
            flaggedResults.push({
              productId: r.productId,
              status: r.status,
              fields: r.fields,
              liveData: { images: liveImages.slice(0, 6) },
            });
            flaggedNames.push({ id: r.productId, name: nameById.get(r.productId) ?? "" });
          }
        }
      }

      // Optional AI post-pass over the flagged rows, in slices: each slice is
      // adjudicated and persisted before the next starts, so an interrupted
      // pass keeps every verdict already paid for and the working set stays a
      // slice deep. Runs inside the image-cache scope so repeat downloads
      // (one vendor image vs several marketplace angles) are deduped.
      // Sets larger than AI_INLINE_MAX are deferred to the background sweep.
      if (useAi && flaggedResults.length > AI_INLINE_MAX) {
        console.log(
          `[verify] ${flaggedResults.length} products flagged for AI checks — ` +
            `deferring to the background image sweep (inline cap ${AI_INLINE_MAX})`,
        );
      }
      if (useAi && flaggedResults.length > 0 && flaggedResults.length <= AI_INLINE_MAX) {
        const productById = new Map(flaggedNames.map((p) => [p.id, p]));
        for (let i = 0; i < flaggedResults.length; i += AI_CHUNK) {
          // Belt-and-braces: never let the AI phase push the request past the
          // budget the lookup loop already respects — return cleanly instead.
          if (Date.now() - startedAt > TIME_BUDGET_MS) break;
          const slice = flaggedResults.slice(i, i + AI_CHUNK);
          const sliceProducts = slice
            .map((r) => productById.get(r.productId))
            .filter((p): p is { id: string; name: string } => !!p);
          await applyAiVerificationPasses(
            slice,
            sliceProducts as unknown as Parameters<typeof applyAiVerificationPasses>[1],
            project.marketplace,
            { onlyFlagged: true },
          );
          // Re-persist only the rows the AI pass could have changed. liveData /
          // asin / price / upc were already written in the batch loop above.
          await persistResults(
            slice.filter((r) => r.status !== "skipped"),
            { statusAndFieldsOnly: true },
          );
        }
      }
    });

    const remaining = Math.max(0, pendingTotal - attempted);
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
      totalProducts,
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
