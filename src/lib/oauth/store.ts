import { prisma } from "@/lib/db";
import { actorOf, type Actor } from "@/lib/authz";
import {
  ACCESS_PREFIX,
  ACCESS_TTL_MS,
  CODE_PREFIX,
  CODE_TTL_MS,
  REFRESH_PREFIX,
  REFRESH_TTL_MS,
  expired,
  hashSecret,
  newSecret,
  redirectUriRegistrable,
  verifyPkce,
  type Scope,
} from "./core";

/**
 * The stateful half: issuing, redeeming and revoking.
 *
 * Everything that can be decided without the database lives in core.ts. What
 * is left here is the part that needs one — and in particular the two rules
 * that are about state rather than arithmetic: a code may be redeemed once,
 * and a refresh token is rotated on every use.
 */

/** Where tokens issued here may be used. Must match what the metadata says. */
export function canonicalResource(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/mcp`;
}

// ── Clients ─────────────────────────────────────────────────────────────────

export async function registerClient(input: {
  name?: unknown;
  redirectUris: unknown;
}): Promise<{ id: string; name: string; redirectUris: string[] } | { error: string }> {
  const uris = Array.isArray(input.redirectUris) ? input.redirectUris.map(String) : [];
  if (!uris.length) return { error: "redirect_uris is required" };
  // Cheap ceiling: registration is open, and a client claiming a hundred
  // callbacks is not a client.
  if (uris.length > 10) return { error: "too many redirect_uris" };
  for (const u of uris) {
    if (!redirectUriRegistrable(u)) return { error: `redirect_uri not allowed: ${u}` };
  }
  const name = String(input.name ?? "").trim().slice(0, 120) || "Unnamed client";
  const row = await prisma.oAuthClient.create({
    data: { name, redirectUris: uris },
    select: { id: true, name: true, redirectUris: true },
  });
  return row;
}

export async function getClient(id: string) {
  if (!id) return null;
  const c = await prisma.oAuthClient.findUnique({
    where: { id },
    select: { id: true, name: true, redirectUris: true, disabledAt: true },
  });
  return c && !c.disabledAt ? c : null;
}

// ── Authorization codes ─────────────────────────────────────────────────────

export async function issueCode(input: {
  clientId: string;
  userId: string;
  redirectUri: string;
  scopes: Scope[];
  codeChallenge: string;
  resource?: string | null;
}): Promise<string> {
  const code = newSecret(CODE_PREFIX);
  await prisma.oAuthCode.create({
    data: {
      codeHash: hashSecret(code),
      clientId: input.clientId,
      userId: input.userId,
      redirectUri: input.redirectUri,
      scope: input.scopes.join(" "),
      codeChallenge: input.codeChallenge,
      resource: input.resource ?? null,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  return code;
}

export type RedeemResult =
  | { ok: true; userId: string; clientId: string; scope: string }
  | { ok: false; error: string };

/**
 * Redeem a code, once.
 *
 * The single-use rule is enforced by a conditional update rather than a read
 * followed by a write: two token requests arriving together would both pass a
 * read-then-check and both be honoured. `updateMany` with `usedAt: null` in
 * the filter makes the database decide, and exactly one wins.
 *
 * A code presented a second time means it leaked. OAuth 2.1 requires every
 * token already issued from it to be revoked — the legitimate client has its
 * tokens, so if the code is replayed, somebody else has it too and we cannot
 * tell which of the two is which.
 */
export async function redeemCode(input: {
  code: string;
  clientId: string;
  redirectUri: string;
  verifier: string;
}): Promise<RedeemResult> {
  const codeHash = hashSecret(input.code);
  const row = await prisma.oAuthCode.findUnique({ where: { codeHash } });
  if (!row) return { ok: false, error: "invalid_grant" };

  if (row.usedAt) {
    await revokeGrantsFromReplay(row.clientId, row.userId);
    return { ok: false, error: "invalid_grant" };
  }
  if (expired(row.expiresAt)) return { ok: false, error: "invalid_grant" };
  // Bound to the client it was issued to, and to the exact callback the user
  // consented to. Either mismatch means this is not the same exchange.
  if (row.clientId !== input.clientId) return { ok: false, error: "invalid_grant" };
  if (row.redirectUri !== input.redirectUri) return { ok: false, error: "invalid_grant" };
  if (!verifyPkce(input.verifier, row.codeChallenge)) return { ok: false, error: "invalid_grant" };

  const claimed = await prisma.oAuthCode.updateMany({
    where: { codeHash, usedAt: null },
    data: { usedAt: new Date() },
  });
  // Lost the race: another request redeemed it between the read and here.
  if (claimed.count === 0) {
    await revokeGrantsFromReplay(row.clientId, row.userId);
    return { ok: false, error: "invalid_grant" };
  }

  return { ok: true, userId: row.userId, clientId: row.clientId, scope: row.scope };
}

async function revokeGrantsFromReplay(clientId: string, userId: string): Promise<void> {
  const now = new Date();
  await prisma.oAuthGrant.updateMany({
    where: { clientId, userId, revokedAt: null },
    data: { revokedAt: now, refreshHash: null },
  });
  console.warn(`[oauth] authorization code replayed — revoked grants for ${userId}/${clientId}`);
}

// ── Grants and tokens ───────────────────────────────────────────────────────

export type IssuedTokens = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
};

export async function issueTokens(input: {
  userId: string;
  clientId: string;
  scope: string;
  grantId?: string;
}): Promise<IssuedTokens> {
  const refreshToken = newSecret(REFRESH_PREFIX);
  const accessToken = newSecret(ACCESS_PREFIX);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_MS);

  const grant = input.grantId
    ? await prisma.oAuthGrant.update({
        where: { id: input.grantId },
        // Rotation: the old refresh token stops working the moment a new one
        // is handed out, so a stolen one is useful only until its owner next
        // refreshes — at which point one of the two fails and it is visible.
        data: { refreshHash: hashSecret(refreshToken), refreshExpiresAt, lastUsedAt: new Date() },
      })
    : await prisma.oAuthGrant.create({
        data: {
          userId: input.userId,
          clientId: input.clientId,
          scope: input.scope,
          refreshHash: hashSecret(refreshToken),
          refreshExpiresAt,
          lastUsedAt: new Date(),
        },
      });

  await prisma.oAuthToken.create({
    data: {
      tokenHash: hashSecret(accessToken),
      grantId: grant.id,
      expiresAt: new Date(Date.now() + ACCESS_TTL_MS),
    },
  });

  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000), scope: grant.scope };
}

export async function refreshTokens(input: {
  refreshToken: string;
  clientId: string;
}): Promise<IssuedTokens | { error: string }> {
  const grant = await prisma.oAuthGrant.findUnique({
    where: { refreshHash: hashSecret(input.refreshToken) },
    select: { id: true, userId: true, clientId: true, scope: true, revokedAt: true, refreshExpiresAt: true },
  });
  if (!grant || grant.revokedAt) return { error: "invalid_grant" };
  if (grant.clientId !== input.clientId) return { error: "invalid_grant" };
  if (expired(grant.refreshExpiresAt)) return { error: "invalid_grant" };
  return issueTokens({
    userId: grant.userId,
    clientId: grant.clientId,
    scope: grant.scope,
    grantId: grant.id,
  });
}

/**
 * The actor behind an access token — the OAuth counterpart of
 * actorForToken, and deliberately the same shape, so the MCP route treats a
 * grant and a personal token identically once resolved.
 */
export async function actorForAccessToken(
  raw: string,
): Promise<{ actor: Actor; grantId: string; scope: string; email: string } | null> {
  const row = await prisma.oAuthToken.findUnique({
    where: { tokenHash: hashSecret(raw) },
    select: {
      expiresAt: true,
      grant: {
        select: {
          id: true, scope: true, revokedAt: true,
          user: { select: { id: true, role: true, teamId: true, email: true } },
        },
      },
    },
  });
  if (!row || expired(row.expiresAt)) return null;
  if (!row.grant || row.grant.revokedAt || !row.grant.user) return null;

  const u = row.grant.user;
  void prisma.oAuthGrant
    .update({ where: { id: row.grant.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});

  return {
    actor: actorOf({ id: u.id, role: u.role, teamId: u.teamId }),
    grantId: row.grant.id,
    scope: row.grant.scope,
    email: u.email,
  };
}

/** Revoking a grant kills its refresh token and every live access token. */
export async function revokeGrant(id: string, opts?: { userId?: string }): Promise<boolean> {
  const { count } = await prisma.oAuthGrant.updateMany({
    where: { id, revokedAt: null, ...(opts?.userId ? { userId: opts.userId } : {}) },
    data: { revokedAt: new Date(), refreshHash: null },
  });
  if (count > 0) await prisma.oAuthToken.deleteMany({ where: { grantId: id } });
  return count > 0;
}

/** Called from the revocation endpoint, which is given a token, not a grant. */
export async function revokeByToken(raw: string): Promise<boolean> {
  const hash = hashSecret(raw);
  if (raw.startsWith(REFRESH_PREFIX)) {
    const g = await prisma.oAuthGrant.findUnique({ where: { refreshHash: hash }, select: { id: true } });
    return g ? revokeGrant(g.id) : false;
  }
  const t = await prisma.oAuthToken.findUnique({ where: { tokenHash: hash }, select: { grantId: true } });
  return t ? revokeGrant(t.grantId) : false;
}
