import { NextRequest, NextResponse } from "next/server";
import { flags } from "@/lib/flags";
import { registerClient } from "@/lib/oauth/store";

export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/**
 * RFC 7591 dynamic client registration.
 *
 * Open, deliberately: that is what makes a connector work without anyone
 * hand-configuring a client id, and it is what claude.ai expects. It is safe
 * because registering grants nothing at all — no token, no access, no
 * relationship with any account. The gate is the consent screen, where the
 * name supplied here is shown as the client's own unverified claim.
 */
export async function POST(req: NextRequest) {
  if (!flags.mcp()) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ error: "invalid_client_metadata" }, { status: 400, headers: CORS });
  }

  const result = await registerClient({
    name: body.client_name,
    redirectUris: body.redirect_uris,
  });
  if ("error" in result) {
    return NextResponse.json(
      { error: "invalid_redirect_uri", error_description: result.error },
      { status: 400, headers: CORS },
    );
  }

  return NextResponse.json(
    {
      client_id: result.id,
      client_name: result.name,
      redirect_uris: result.redirectUris,
      // No secret: a client that runs in a browser or on a laptop cannot keep
      // one, and pretending otherwise is how secrets end up in logs. PKCE is
      // what authenticates the exchange instead.
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    },
    { status: 201, headers: CORS },
  );
}
