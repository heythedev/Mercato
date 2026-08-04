import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { NewProjectForm } from "@/components/projects/new-project-form";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";

export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  const user = await requireUser();
  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: { role: true, allowedMarketplaces: true },
  });
  const allowedTiles = account?.role === "admin"
    ? MARKETPLACE_IDS
    : (account?.allowedMarketplaces ?? []);

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold tracking-tight">New Project</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Upload a vendor file and select a marketplace to get started.
        </p>
      </div>
      <NewProjectForm allowedTiles={allowedTiles} />
    </div>
  );
}
