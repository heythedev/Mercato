import { requireAnyAdmin } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { AdminUsersClient } from "@/components/admin/users-client";
import { actorOf, isAdmin } from "@/lib/authz";
import { PageHeader } from "@/components/ui/primitives";

export default async function AdminUsersPage() {
  const account = await requireAnyAdmin();
  const actor = actorOf(account);

  const [users, teams] = await Promise.all([
    prisma.user.findMany({
      // A team admin administers one team and sees exactly that team.
      where: isAdmin(actor) ? {} : { teamId: actor.teamId },
      select: {
        id: true, name: true, email: true, role: true,
        allowedMarketplaces: true, createdAt: true, teamId: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    // Only the super admin can move people between teams, so only they need
    // the full list.
    isAdmin(actor)
      ? prisma.team.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } })
      : Promise.resolve([]),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <PageHeader title="Users" subtitle="Manage user accounts and roles" />
      <AdminUsersClient users={users} teams={teams} isSuperAdmin={isAdmin(actor)} />
    </div>
  );
}
