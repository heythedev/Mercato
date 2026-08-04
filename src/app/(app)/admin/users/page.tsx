import { requireAdmin } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { AdminUsersClient } from "@/components/admin/users-client";

export default async function AdminUsersPage() {
  await requireAdmin();

  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, allowedMarketplaces: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Users</h1>
        <p className="text-muted-foreground text-sm mt-1">Manage user accounts and roles</p>
      </div>
      <AdminUsersClient users={users} />
    </div>
  );
}
