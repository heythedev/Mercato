import { NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import {
  getLastSynccentricQuota,
  synccentricConfigured,
  synccentricPrimary,
  testSynccentric,
} from "@/lib/synccentric/client";

export const dynamic = "force-dynamic";

/** Synccentric daily search quota for the sidebar widget. Serves the quota
 *  captured from the most recent real search when it's fresh; otherwise runs
 *  a 1-credit probe to repopulate it (negligible against the daily limit).
 *  `?fresh=1` — the widget's refresh button — always probes. */
export async function GET(req: Request) {
  const { response } = await authGuard();
  if (response) return response;

  if (!synccentricConfigured()) {
    return NextResponse.json({ configured: false });
  }

  const fresh = new URL(req.url).searchParams.get("fresh") === "1";
  const MAX_AGE_MS = 5 * 60 * 1000;
  let quota = getLastSynccentricQuota();
  if (fresh || !quota || Date.now() - quota.timestamp > MAX_AGE_MS) {
    await testSynccentric(); // side effect: captures quota from response headers
    quota = getLastSynccentricQuota();
  }

  return NextResponse.json({
    configured: true,
    primary: synccentricPrimary(),
    remaining: quota?.remaining ?? null,
    limit: quota?.limit ?? null,
    used: quota?.used ?? null,
  });
}
