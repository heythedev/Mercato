import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { recoverStaleProjects } from "@/lib/projects/recover-stale";
import { ProjectsView } from "@/components/projects/projects-view";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";
import { actorOf, allowedMarketplacesFor, projectListScope } from "@/lib/authz";

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
    select: { role: true, allowedMarketplaces: true },
  });
  // Role comes from the row just read, not the session, so a change of role
  // takes effect on the next page load rather than the next sign-in.
  const actor = actorOf({ id: user.id, role: account?.role });
  const allowedTiles = allowedMarketplacesFor(actor, MARKETPLACE_IDS, account?.allowedMarketplaces);

  const projects = await prisma.project.findMany({
    where: projectListScope(actor),
    include: { _count: { select: { products: true } } },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <ProjectsView
      allowedTiles={allowedTiles}
      projects={projects.map((p) => ({
        id: p.id,
        name: p.name,
        marketplace: p.marketplace,
        marketplaceLabel: MARKETPLACE_LABELS[p.marketplace] ?? p.marketplace,
        status: p.status,
        productCount: p._count.products,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
      }))}
    />
  );
}
