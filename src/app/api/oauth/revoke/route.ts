import { NextRequest, NextResponse } from "next/server";
import { flags } from "@/lib/flags";
import { revokeByToken } from "@/lib/oauth/store";

export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
  "cache-control": "no-store",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * RFC 7009. Disconnecting in Claude should actually disconnect.
 *
 * Always answers 200, even for a token that does not exist. The RFC requires
 * it, and the reason is sound: a different answer for a valid token would let
 * anyone test whether a stolen string is live.
 */
export async function POST(req: NextRequest) {
  if (!flags.mcp()) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const ct = req.headers.get("content-type") ?? "";
  let token = "";
  if (ct.includes("application/json")) {
    token = String(((await req.json().catch(() => ({}))) as { token?: string })?.token ?? "");
  } else {
    const form = await req.formData().catch(() => null);
    token = String(form?.get("token") ?? "");
  }

  if (token) await revokeByToken(token).catch(() => false);
  return new NextResponse(null, { status: 200, headers: CORS });
}
