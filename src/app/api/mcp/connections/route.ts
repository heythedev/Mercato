import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { revokeGrant } from "@/lib/oauth/store";

/**
 * The Claude connections on your own account, and how to end one.
 *
 * Until this existed a grant could be made and never taken back: revokeGrant
 * was written and tested but nothing called it, so the only way out of a
 * connection was a database edit. That is the wrong answer for somebody who
 * approved on a shared machine and bound Claude to the account the browser
 * happened to be signed into.
 *
 * Like the token routes, every handler acts on the signed-in user and takes no
 * parameter for whose connection to end, so there is no way to revoke
 * somebody else's.
 */

export async function GET() {
  const { user, response } = await authGuard();
  if (response) return response;

  const grants = await prisma.oAuthGrant.findMany({
    where: { userId: user!.id, revokedAt: null },
    select: {
      id: true,
      scope: true,
      createdAt: true,
      lastUsedAt: true,
      client: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    connections: grants.map((g) => ({
      id: g.id,
      // The name the application gave for itself at registration — a claim,
      // and shown as one wherever it is displayed.
      name: g.client?.name ?? "Unknown application",
      scope: g.scope,
      canWrite: g.scope.split(/\s+/).includes("mercato:write"),
      connectedAt: g.createdAt,
      lastUsedAt: g.lastUsedAt,
    })),
  });
}

export async function DELETE(req: NextRequest) {
  const { user, response } = await authGuard();
  if (response) return response;

  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "Which connection?" }, { status: 400 });

  // The userId guard is the whole point: a grant id from somewhere else must
  // not end somebody else's connection.
  const ended = await revokeGrant(id, { userId: user!.id });
  if (!ended) {
    // Already gone, or never theirs. One answer for both: which of the two it
    // is tells a caller whether an id they do not own exists.
    return NextResponse.json({ error: "No such connection on your account" }, { status: 404 });
  }
  return NextResponse.json({ ended: true });
}
