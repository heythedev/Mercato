import { requireAnyAdmin } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { AdminTemplatesClient } from "@/components/admin/templates-client";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";
import { PageHeader } from "@/components/ui/primitives";

export default async function AdminTemplatesPage() {
  await requireAnyAdmin();

  // Exclude fileData (BYTEA blob) — the raw workbook can't be serialized into
  // the page payload and the client only needs the column definitions.
  const templates = await prisma.exportTemplate.findMany({
    omit: { fileData: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <PageHeader
        title="Export Templates"
        subtitle="Manage marketplace export templates and column mappings"
      />
      <AdminTemplatesClient templates={templates} isAdmin={true} allowedTiles={MARKETPLACE_IDS} />
    </div>
  );
}
