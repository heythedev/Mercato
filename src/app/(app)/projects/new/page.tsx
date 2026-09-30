import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { NewProjectForm } from "@/components/projects/new-project-form";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";
import { actorOf, allowedMarketplacesFor } from "@/lib/authz";
import { PageHeader } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function NewProjectPage() {
  const user = await requireUser();
  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: { role: true, allowedMarketplaces: true },
  });
  // Same rule as the projects list: only the super admin implicitly holds every
  // marketplace. A team admin is bounded by their allow-list like anyone else.
  const allowedTiles = allowedMarketplacesFor(
    actorOf({ id: user.id, role: account?.role }),
    MARKETPLACE_IDS,
    account?.allowedMarketplaces,
  );

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <PageHeader
        title="New Project"
        subtitle="Upload a vendor file and select a marketplace to get started."
      />
      <NewProjectForm allowedTiles={allowedTiles} />
    </div>
  );
}
