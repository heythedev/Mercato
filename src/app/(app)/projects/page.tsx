import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { recoverStaleProjects } from "@/lib/projects/recover-stale";
import { ProjectsView } from "@/components/projects/projects-view";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";
import { actorOf, allowedMarketplacesFor, isAnyAdmin, projectListScope } from "@/lib/authz";

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
      }))}
    />
  );
}
