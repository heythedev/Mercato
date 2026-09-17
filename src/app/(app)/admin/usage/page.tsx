import { requireAdmin } from "@/lib/auth-helpers";
import { AdminUsageClient } from "@/components/admin/usage-client";

/**
 * Admin-only report of what the paid balances were spent on — Kimi (AI), Keepa
 * and Synccentric.
 *
 * None of the three providers reports history: Kimi exposes a balance and no
 * usage endpoint at all, Keepa and Synccentric return only a running quota. So
 * once credits drain there is otherwise nothing to inspect. Every billable call
 * records a row (src/lib/ai/usage-log.ts); this page reads them back and offers
 * the raw call list as a CSV download.
 */
export default async function AdminUsagePage() {
  await requireAdmin();

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Usage &amp; credits</h1>
        <p className="text-muted-foreground text-sm mt-1">
          What Kimi, Keepa and Synccentric credits were spent on — by day, service, feature and project
        </p>
      </div>
      <AdminUsageClient />
    </div>
  );
}
