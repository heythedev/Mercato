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

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      products: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          vendorSku: true,
          upc: true,
          asin: true,
          brand: true,
          price: true,
          imageUrl: true,
          verifyStatus: true,
          verifyFields: true,
          marketplaceCategory: true,
          categoryPath: true,
          categorizedAt: true,
          verifiedAt: true,
        },
      },
    },
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
      products={project.products.map((p) => ({
        ...p,
        verifyFields: p.verifyFields as unknown as Record<string, unknown>[] | null,
      }))}
    />
  );
}
