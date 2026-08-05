import { prisma } from "@/lib/db";
import { SKIP_VERIFY_MARKETPLACES } from "@/lib/projects/marketplace-flow";

/**
 * Transient project statuses are written at the *start* of a long-running
 * request (verify / categorize / export) and only cleared when that same
 * request finishes. If the request is killed before it completes — the 300s
 * `maxDuration` ceiling, a server restart, a crash, or the machine sleeping —
 * the project is stranded in the transient status forever, because nothing
 * else ever resets it.
 *
 * This recovers any project that has sat in a transient status past the point
 * where a live request could still be running, mapping each transient status
 * back to the same stable status its own route's error handler falls back to.
 */

// `maxDuration` is 300s; add a buffer so we never clobber a run that is
// legitimately still in progress near the ceiling.
const STALE_MS = 6 * 60 * 1000;

// transient status → the stable status to recover to (mirrors each route's
// catch handler): verify → uploaded, export → categorized. `categorizing` is
// handled separately below because its fallback is marketplace-dependent
// (skip-verify marketplaces roll back to "uploaded", others to "verified").
const RECOVERY: Record<string, string> = {
  verifying: "uploaded",
  exporting: "categorized",
};

/**
 * Reset stale in-progress projects. Scope the sweep with `userId` (list view)
 * or `id` (single project) to avoid touching unrelated rows.
 */
export async function recoverStaleProjects(
  scope: { userId?: string; id?: string } = {},
): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_MS);
  const skipVerify = [...SKIP_VERIFY_MARKETPLACES];
  try {
    await Promise.all([
      // Fixed-fallback transient statuses.
      ...Object.entries(RECOVERY).map(([from, to]) =>
        prisma.project.updateMany({
          where: { ...scope, status: from, updatedAt: { lt: cutoff } },
          data: { status: to },
        }),
      ),
      // Stale categorizing: skip-verify marketplaces have no "verified" state, so
      // roll them back to "uploaded"; everyone else rolls back to "verified".
      // marketplace is stored lowercase, matched case-insensitively to be safe.
      prisma.project.updateMany({
        where: {
          ...scope, status: "categorizing", updatedAt: { lt: cutoff },
          marketplace: { in: skipVerify, mode: "insensitive" },
        },
        data: { status: "uploaded" },
      }),
      prisma.project.updateMany({
        where: {
          ...scope, status: "categorizing", updatedAt: { lt: cutoff },
          marketplace: { notIn: skipVerify, mode: "insensitive" },
        },
        data: { status: "verified" },
      }),
    ]);

    // Rolling back is right when the work was lost — but a categorize run can
    // die AFTER writing every product and BEFORE stamping the project (the
    // completion update is the very last statement, and the job lives in
    // process memory, so a restart there loses only the stamp). Those projects
    // have a full set of results and should be finished, not rewound: rolling
    // them back to "verified" hides completed work and, because
    // categorizeCompletedAt stays null, the UI can never show a run duration.
    await finishFullyCategorized(scope);
  } catch (err) {
    // Recovery is best-effort — never let it block the page/route it guards.
    console.error("[recover-stale] failed to reset stale projects:", err);
  }
}

/**
 * Promote projects whose products are all categorized to a completed state.
 *
 * Runs after the rollback sweep, so it also repairs rows that sweep just moved
 * backwards. Only touches projects with at least one product where none is
 * missing a category — a partially-categorized project stays rolled back so the
 * user re-runs it.
 */
async function finishFullyCategorized(scope: { userId?: string; id?: string }): Promise<void> {
  const candidates = await prisma.project.findMany({
    where: {
      ...scope,
      // "categorizing" if the sweep hasn't run yet; the rolled-back states if it has.
      status: { in: ["categorizing", "verified", "uploaded"] },
      categorizeCompletedAt: null,
    },
    select: { id: true, updatedAt: true, _count: { select: { products: true } } },
  });

  for (const c of candidates) {
    if (c._count.products === 0) continue;
    const missing = await prisma.product.count({
      where: { projectId: c.id, marketplaceCategory: null },
    });
    if (missing > 0) continue; // genuinely incomplete — leave it for a re-run

    // categorizeMs is deliberately left as-is: the real duration died with the
    // process, and inventing one would misreport how long the run took. The UI
    // omits the duration line when it is missing rather than showing a made-up
    // number, while still showing the run as complete.
    await prisma.project.update({
      where: { id: c.id },
      data: { status: "categorized", categorizeCompletedAt: new Date() },
    }).catch(() => { /* best-effort */ });
  }
}
