import { NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { synccentricConfigured, testSynccentric } from "@/lib/synccentric/client";

export const dynamic = "force-dynamic";

/** Synccentric connectivity probe. Reports whether SYNCCENTRIC_API_TOKEN is
 *  present in this deployment and whether a live search authenticates with it
 *  (costs 1 search credit per call). Exists so a misconfigured production env
 *  var is diagnosable without Render log access. */
export async function GET() {
  const { response } = await authGuard();
  if (response) return response;

  if (!synccentricConfigured()) {
    return NextResponse.json({
      configured: false,
      ok: false,
      message: "SYNCCENTRIC_API_TOKEN not configured",
    });
  }

  const result = await testSynccentric();
  return NextResponse.json({ configured: true, ...result });
}
