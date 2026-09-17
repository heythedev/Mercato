import { requireAdmin } from "@/lib/auth-helpers";
import { AdminExportDefaultsClient } from "@/components/admin/export-defaults-client";

/**
 * Admin-only values for required export columns that no data source can answer.
 *
 * Compliance declarations are the motivating case: Prop 65 warning type and the
 * PFAS statement are the same on every row, the seller states them rather than
 * the product carrying them, and they accounted for 64 of the 462 empty
 * required cells measured on the live Best Buy project. Entering them once here
 * fills those cells deterministically and removes them from the AI queue.
 */
export default async function AdminExportDefaultsPage() {
  await requireAdmin();

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Export defaults</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Fixed values for required columns no vendor file or catalog can answer — compliance
          declarations and the like
        </p>
      </div>
      <AdminExportDefaultsClient />
    </div>
  );
}
