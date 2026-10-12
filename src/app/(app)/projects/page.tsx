import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { recoverStaleProjects } from "@/lib/projects/recover-stale";
import { ProjectsView } from "@/components/projects/projects-view";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";
import { actorOf, allowedMarketplacesFor, isAnyAdmin, projectListScope } from "@/lib/authz";
import { EMPTY_HEALTH, type ProjectHealth } from "@/lib/projects/health";

export const dynamic = "force-dynamic";

const MARKETPLACE_LABELS: Record<string, string> = {
  amazon: "Amazon",
  amazon_us: "Amazon US",
  bestbuy: "Best Buy",
  walmart: "Walmart",
  temu: "Temu",
  mathis: "Mathis",
  sears: "Sears",
  wayfair: "Wayfair",
};

export default async function ProjectsPage() {
  const user = await requireUser();

  await recoverStaleProjects({ userId: user.id });

  // Marketplaces this user may create projects for. Admins get all; everyone
  // else gets their explicit allow-list. Drives which tiles the new-project
  // form shows (the server also enforces this on create).
  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: { role: true, allowedMarketplaces: true, teamId: true },
  });
  // Role AND team come from the row just read, not the session, so a change to
  // either takes effect on the next page load rather than the next sign-in.
  //
  // teamId was missing here, which mattered: projectListScope gives a team
  // admin `{ OR: [{ teamId: actor.teamId }, …] }`, and with teamId undefined
  // that became `{ teamId: null }` — a filter matching every project that has
  // no team at all. Three rows in the live database have none.
  const actor = actorOf({ id: user.id, role: account?.role, teamId: account?.teamId });
  const allowedTiles = allowedMarketplacesFor(actor, MARKETPLACE_IDS, account?.allowedMarketplaces);

  // Who owns each project. An admin's list is everyone's work — 136 projects
  // across five people on the live database, 52 of them the admin's own — and
  // without a name on the card there is no way to tell whose is whose.
  const projects = await prisma.project.findMany({
    where: projectListScope(actor),
    include: {
      _count: { select: { products: true } },
      user: { select: { id: true, name: true, email: true } },
      team: { select: { name: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  // Only worth showing when the list can actually hold someone else's work. A
  // plain user sees only their own projects, so an owner on every card would
  // be the same word repeated down the page.
  const showsOthersWork = isAnyAdmin(actor);

  const health = await loadHealth(projects.map((p) => p.id));

  return (
    <ProjectsView
      allowedTiles={allowedTiles}
      showOwner={showsOthersWork}
      projects={projects.map((p) => ({
        id: p.id,
        name: p.name,
        marketplace: p.marketplace,
        marketplaceLabel: MARKETPLACE_LABELS[p.marketplace] ?? p.marketplace,
        status: p.status,
        productCount: p._count.products,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        ownerId: p.userId,
        // Name when the account has one, otherwise the local part of the email
        // — "payel.m" reads better on a card than the whole address.
        ownerName: p.user?.name?.trim() || p.user?.email?.split("@")[0] || "Unknown",
        ownerEmail: p.user?.email ?? "",
        teamName: p.team?.name ?? null,
        isMine: p.userId === user.id,
        health: health.get(p.id) ?? EMPTY_HEALTH,
      }))}
    />
  );
}

/**
 * The card health counts for every listed project, in two grouped queries
 * rather than one per card. Both filter on projectId, which is indexed.
 *
 * Best-effort: the counts decorate the cards, so a failure here costs the
 * badges and never the page.
 */
async function loadHealth(ids: string[]): Promise<Map<string, ProjectHealth>> {
  const out = new Map<string, ProjectHealth>();
  if (!ids.length) return out;
  try {
    const counts = await prisma.$queryRaw<
      { projectId: string; uncategorized: bigint; verifyIssues: bigint; missingImage: bigint }[]
    >`
      SELECT "projectId",
        COUNT(*) FILTER (WHERE "marketplaceCategory" IS NULL OR "marketplaceCategory" = '' OR "marketplaceCategory" = 'Uncategorized') AS "uncategorized",
        COUNT(*) FILTER (WHERE "verifyStatus" IN ('mismatch', 'not_found')) AS "verifyIssues",
        COUNT(*) FILTER (WHERE "imageUrl" IS NULL OR "imageUrl" = '') AS "missingImage"
      FROM "Product"
      WHERE "projectId" = ANY(${ids})
      GROUP BY "projectId"`;
    // A UPC on more than one product in the same project. Nearly always the
    // vendor file's UPC column saved by Excel as a number (7.34205E+11), which
    // rounds many real codes onto one.
    const shared = await prisma.$queryRaw<{ projectId: string; n: bigint }[]>`
      SELECT "projectId", SUM(c) AS n FROM (
        SELECT "projectId", "upc", COUNT(*) AS c
        FROM "Product"
        WHERE "projectId" = ANY(${ids}) AND "upc" IS NOT NULL AND "upc" <> ''
        GROUP BY "projectId", "upc"
        HAVING COUNT(*) > 1
      ) dup
      GROUP BY "projectId"`;
    for (const r of counts) {
      out.set(r.projectId, {
        uncategorized: Number(r.uncategorized),
        verifyIssues: Number(r.verifyIssues),
        missingImage: Number(r.missingImage),
        sharedUpc: 0,
      });
    }
    for (const r of shared) {
      const h = out.get(r.projectId) ?? { ...EMPTY_HEALTH };
      out.set(r.projectId, { ...h, sharedUpc: Number(r.n) });
    }
  } catch (e) {
    console.warn("[projects] health counts unavailable:", (e as Error).message);
  }
  return out;
}
