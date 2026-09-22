import { requireAnyAdmin } from "@/lib/auth-helpers";
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
  await requireAnyAdmin();

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Usage &amp; credits</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Where the money goes. Mercato pays three outside services to do its work — this is what
          each one cost, what triggered it, and whether it can still run.
        </p>
      </div>
      <AdminUsageClient />
    </div>
  );
}
