import { NextRequest, NextResponse } from "next/server";
import { flags } from "@/lib/flags";
import { getClient, issueTokens, redeemCode, refreshTokens } from "@/lib/oauth/store";

export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "POST, OPTIONS",
};
// A token response must never be cached — by the browser, by a CDN, by
// anything. RFC 6749 says so explicitly and it is the kind of header that is
// forgotten until a shared cache hands somebody else's token out.
const NO_STORE = { "cache-control": "no-store", pragma: "no-cache", ...CORS };

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function fail(error: string, description?: string, status = 400) {
  return NextResponse.json({ error, ...(description ? { error_description: description } : {}) }, {
    status,
    headers: NO_STORE,
  });
}

export async function POST(req: NextRequest) {
  if (!flags.mcp()) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Form-encoded is what the spec mandates; JSON is accepted because some
  // clients send it and refusing would be pedantry with no security benefit.
  const ct = req.headers.get("content-type") ?? "";
  let p: Record<string, string> = {};
  if (ct.includes("application/json")) {
    p = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, string>;
  } else {
    const form = await req.formData().catch(() => null);
    if (form) for (const [k, v] of form.entries()) p[k] = String(v);
  }

  const clientId = String(p.client_id ?? "");
  const client = await getClient(clientId);
  if (!client) return fail("invalid_client", "Unknown or disabled client", 401);

  if (p.grant_type === "refresh_token") {
    const out = await refreshTokens({ refreshToken: String(p.refresh_token ?? ""), clientId });
    if ("error" in out) return fail(out.error);
    return NextResponse.json(
      {
        access_token: out.accessToken,
        token_type: "Bearer",
        expires_in: out.expiresIn,
        refresh_token: out.refreshToken,
        scope: out.scope,
      },
      { headers: NO_STORE },
    );
  }

  if (p.grant_type !== "authorization_code") {
    return fail("unsupported_grant_type");
  }

  const redeemed = await redeemCode({
    code: String(p.code ?? ""),
    clientId,
    redirectUri: String(p.redirect_uri ?? ""),
    verifier: String(p.code_verifier ?? ""),
  });
  // Deliberately one message for every failure mode. Telling a caller
  // whether the code was unknown, expired, already used or simply had the
  // wrong verifier is an oracle, and none of it helps a legitimate client.
  if (!redeemed.ok) return fail(redeemed.error, "The authorization code could not be redeemed");

  const out = await issueTokens({
    userId: redeemed.userId,
    clientId: redeemed.clientId,
    scope: redeemed.scope,
  });
  return NextResponse.json(
    {
      access_token: out.accessToken,
      token_type: "Bearer",
      expires_in: out.expiresIn,
      refresh_token: out.refreshToken,
      scope: out.scope,
    },
    { headers: NO_STORE },
  );
}
