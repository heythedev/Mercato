import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { AdminTemplatesClient } from "@/components/admin/templates-client";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";
import {
  actorOf,
  adminUserIds,
  allowedMarketplacesFor,
  isAdmin,
  isGlobalTemplate,
  templateVisibilityOr,
} from "@/lib/authz";

export default async function TemplatesPage() {
  const user = await requireUser();
  const actor = actorOf(user);

  // Marketplaces this user may work with — admins get all tiles.
  const account = await prisma.user.findUnique({
    where: { id: user.id },
    select: { allowedMarketplaces: true },
  });
  const allowedTiles = allowedMarketplacesFor(actor, MARKETPLACE_IDS, account?.allowedMarketplaces);

  // Fetch admin user IDs so their templates also appear as global defaults.
  // Some may have userId=adminId instead of null if uploaded before the null convention.
  const adminIds = await adminUserIds();
  const adminIdSet = new Set(adminIds);

  // Exclude fileData (BYTEA blob) — the raw workbook can't be serialized into
  // the page payload and the client only needs the column definitions.
  const rawTemplates = await prisma.exportTemplate.findMany({
    where: { OR: templateVisibilityOr(actor, adminIds) },
    omit: { fileData: true },
    orderBy: { createdAt: "desc" },
  });

  // Treat admin-owned templates as userId=null for display (shows Admin badge, hides edit/delete).
  const templates = rawTemplates.map((t) => ({
    ...t,
    userId: isGlobalTemplate(t, adminIdSet) ? null : t.userId,
  }));

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">My Templates</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Upload your marketplace template files — columns are auto-detected and used for export
        </p>
      </div>
      <AdminTemplatesClient templates={templates} isAdmin={isAdmin(actor)} allowedTiles={allowedTiles} />
    </div>
  );
}
