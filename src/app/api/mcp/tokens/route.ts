import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { issueToken, listTokens, revokeToken } from "@/lib/mcp/tokens";

/**
 * Managing your own MCP tokens.
 *
 * Every handler scopes to the signed-in user and nothing else — there is no
 * parameter for whose tokens to act on, so there is no way to ask for
 * someone else's. Even the super admin manages only their own here: an
 * administrator needing to cut off a departing colleague should disable the
 * account, which revokes by cascade, rather than reach into their credentials.
 */

export async function GET() {
  const { user, response } = await authGuard();
  if (response) return response;
  return NextResponse.json({ tokens: await listTokens(user!.id) });
}

export async function POST(req: NextRequest) {
  const { user, response } = await authGuard();
  if (response) return response;

  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = (body.name ?? "").trim().slice(0, 60);
  if (!name) return NextResponse.json({ error: "Give the token a name" }, { status: 400 });

  const existing = await listTokens(user!.id);
  // Not a security boundary — just a limit that keeps the list readable and
  // makes an accidental loop obvious rather than expensive.
  if (existing.filter((t) => !t.revokedAt).length >= 10) {
    return NextResponse.json(
      { error: "You already have 10 active tokens. Revoke one first." },
      { status: 400 },
    );
  }

  const issued = await issueToken(user!.id, name);
  // The only time the plaintext exists outside the client's memory. Not
  // logged, not stored, not recoverable — the row holds a SHA-256.
  return NextResponse.json({
    token: issued.token,
    id: issued.id,
    prefix: issued.prefix,
    warning: "Copy it now. It cannot be shown again.",
  });
}

export async function DELETE(req: NextRequest) {
  const { user, response } = await authGuard();
  if (response) return response;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const done = await revokeToken(user!.id, id);
  // A token that is not yours reads as absent rather than forbidden — there
  // is no reason to confirm to anyone that someone else's id exists.
  if (!done) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ revoked: true });
}
