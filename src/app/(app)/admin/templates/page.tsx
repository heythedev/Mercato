import { requireAdmin } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { AdminTemplatesClient } from "@/components/admin/templates-client";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";

export default async function AdminTemplatesPage() {
  await requireAdmin();

  // Exclude fileData (BYTEA blob) — the raw workbook can't be serialized into
  // the page payload and the client only needs the column definitions.
  const templates = await prisma.exportTemplate.findMany({
    omit: { fileData: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Export Templates</h1>
        <p className="text-muted-foreground text-sm mt-1">Manage marketplace export templates and column mappings</p>
      </div>
      <AdminTemplatesClient templates={templates} isAdmin={true} allowedTiles={MARKETPLACE_IDS} />
    </div>
  );
}
