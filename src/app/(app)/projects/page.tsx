import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { recoverStaleProjects } from "@/lib/projects/recover-stale";
import { ProjectsView } from "@/components/projects/projects-view";

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

  const projects = await prisma.project.findMany({
    where: { userId: user.id },
    include: { _count: { select: { products: true } } },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <ProjectsView
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
