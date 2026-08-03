import { NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { refreshKeepaTokens } from "@/lib/keepa/client";

export const dynamic = "force-dynamic";

/** Current Keepa token balance. Hits Keepa's `token` endpoint fresh each call
 *  so the "refresh" button in the UI reflects live figures. */
export async function GET() {
  const { response } = await authGuard();
  if (response) return response;

  if (!process.env.KEEPA_API_KEY) {
    return NextResponse.json({ error: "KEEPA_API_KEY not configured", configured: false }, { status: 200 });
  }

  const info = await refreshKeepaTokens();
  if (!info) {
    return NextResponse.json({ error: "Could not reach Keepa", configured: true }, { status: 502 });
  }

  return NextResponse.json({
    configured: true,
    tokensLeft: info.tokensLeft,
    refillRate: info.refillRate,
    refillIn: info.refillIn,
  });
}
