import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { recoverStaleProjects } from "@/lib/projects/recover-stale";
import { ProjectDetail } from "@/components/projects/project-detail";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  await recoverStaleProjects({ id });

  // Deliberately NO products here: rendering the whole catalog into one RSC
  // payload is what killed the 512 MB instance at 10k rows ("Connection
  // closed"). The client pulls products in pages from /api/projects/[id]/products.
  const project = await prisma.project.findUnique({
    where: { id },
    include: { _count: { select: { products: true } } },
  });

  if (!project) notFound();
  if (project.userId !== user.id && (user as { role?: string }).role !== "admin") {
    redirect("/projects");
  }

  return (
    <ProjectDetail
      project={{
        id: project.id,
        name: project.name,
        marketplace: project.marketplace,
        status: project.status,
        isNewListing: project.isNewListing,
        verifyMs: project.verifyMs,
        verifyCompletedAt: project.verifyCompletedAt?.toISOString() ?? null,
        categorizeMs: project.categorizeMs,
        categorizeCompletedAt: project.categorizeCompletedAt?.toISOString() ?? null,
      }}
      productCount={project._count.products}
    />
  );
}
