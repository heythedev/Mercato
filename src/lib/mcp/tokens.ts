import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { actorOf, type Actor } from "@/lib/authz";
import { ACCESS_PREFIX } from "@/lib/oauth/core";
import { actorForAccessToken } from "@/lib/oauth/store";

/**
 * Personal access tokens for the MCP endpoint.
 *
 * The point of these is identity, not convenience. A single shared secret —
 * the obvious first design — makes every caller equally powerful and quietly
 * undoes every scope in authz.ts: a member would reach a colleague's private
 * templates, a team admin another team's projects. The work that made those
 * rules correct would be bypassed by the one door left open.
 *
 * So a token belongs to exactly one person, and every tool builds its actor
 * from that person. Through MCP you can see precisely what you can see in the
 * browser, and nothing further.
 */

const PREFIX = "mrc_";
/** 32 bytes of randomness. Guessing is not a threat model worth entertaining. */
const BYTES = 32;

export type IssuedToken = { token: string; id: string; prefix: string };

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Mint a token for a user. The plaintext is returned ONCE and never stored —
 * only its SHA-256. A database dump must not be a set of live credentials,
 * which stopped being theoretical the day backups started leaving the server.
 */
export async function issueToken(userId: string, name: string): Promise<IssuedToken> {
  const token = PREFIX + randomBytes(BYTES).toString("base64url");
  const row = await prisma.mcpToken.create({
    data: {
      userId,
      tokenHash: hash(token),
      // Enough to tell two tokens apart in a list, too little to be useful
      // to anyone who reads it over a shoulder.
      prefix: token.slice(0, PREFIX.length + 6),
      name: name.trim() || "Claude",
    },
    select: { id: true, prefix: true },
  });
  return { token, id: row.id, prefix: row.prefix };
}

/**
 * The actor behind a bearer token, or null.
 *
 * Looked up by hash, so the plaintext is never compared against anything
 * stored. The constant-time check that follows is belt and braces — the
 * lookup is already an indexed equality on a digest — but it costs nothing
 * and removes the question.
 */
export async function actorForToken(
  raw: string | null | undefined,
): Promise<{ actor: Actor; tokenId: string; email: string; scope?: string } | null> {
  if (!raw) return null;
  const token = raw.replace(/^Bearer\s+/i, "").trim();

  // An OAuth access token is resolved by its own path. Checked FIRST, and by
  // an exact prefix, because `mrc_a_…` also starts with `mrc_` — falling
  // through to the personal-token lookup would hash it, miss, and report a
  // valid credential as invalid.
  if (token.startsWith(ACCESS_PREFIX)) {
    const g = await actorForAccessToken(token);
    return g ? { actor: g.actor, tokenId: g.grantId, email: g.email, scope: g.scope } : null;
  }

  if (!token.startsWith(PREFIX)) return null;

  const digest = hash(token);
  const row = await prisma.mcpToken.findUnique({
    where: { tokenHash: digest },
    select: {
      id: true,
      tokenHash: true,
      revokedAt: true,
      user: { select: { id: true, role: true, teamId: true, email: true } },
    },
  });
  if (!row || row.revokedAt || !row.user) return null;

  const a = Buffer.from(row.tokenHash);
  const b = Buffer.from(digest);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Best-effort: a failed bookkeeping write must never cost someone access.
  // Also deliberately not awaited on the hot path for every tool call — the
  // resolution is a day, not a millisecond.
  void prisma.mcpToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    actor: actorOf({ id: row.user.id, role: row.user.role, teamId: row.user.teamId }),
    tokenId: row.id,
    email: row.user.email,
  };
}

/** A user's tokens, for the settings screen. Never includes a usable secret. */
export async function listTokens(userId: string) {
  return prisma.mcpToken.findMany({
    where: { userId },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, revokedAt: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Revoke, rather than delete: a token that was once live is worth keeping a
 * record of, and `revokedAt` refuses it just as firmly as a missing row.
 * Scoped by userId so one person cannot revoke another's.
 */
export async function revokeToken(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.mcpToken.updateMany({
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return count > 0;
}
