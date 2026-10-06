import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The parts of OAuth that must not be wrong, kept pure so they can be tested
 * without a database, a browser or a round trip.
 *
 * Everything here is a check that, if it is subtly wrong, does not fail — it
 * silently permits. A redirect URI matched by prefix instead of exactly hands
 * tokens to an attacker's host. A PKCE comparison that is really a string
 * equality on the challenge defeats the whole exchange. An authorization code
 * that can be used twice is a replay. None of those produce an error anybody
 * sees, which is why they live in one file with tests rather than inline in a
 * route handler.
 */

// ── Identifiers and secrets ─────────────────────────────────────────────────

/**
 * Prefixes, so a credential says what it is on sight — in a log, in a support
 * ticket, in a leaked file. Deliberately distinct from the personal-token
 * prefix (`mrc_`) so the two paths can never be confused for one another at
 * lookup time.
 */
export const ACCESS_PREFIX = "mrc_a_";
export const REFRESH_PREFIX = "mrc_r_";
export const CODE_PREFIX = "mrc_c_";

export function newSecret(prefix: string): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** Stored form. The database must never hold a usable credential. */
export function hashSecret(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Constant-time, for comparing a presented secret against a stored digest. */
export function secretMatches(raw: string, storedHash: string): boolean {
  const a = Buffer.from(hashSecret(raw));
  const b = Buffer.from(storedHash);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── PKCE ────────────────────────────────────────────────────────────────────

/**
 * S256 only.
 *
 * `plain` is in the spec and is worthless: the challenge IS the verifier, so
 * anyone who intercepted the authorization request can complete the exchange.
 * OAuth 2.1 requires S256 for public clients and we have no others.
 */
export function verifyPkce(verifier: string, challenge: string, method = "S256"): boolean {
  if (method !== "S256") return false;
  if (typeof verifier !== "string") return false;
  // RFC 7636: 43–128 characters from an unreserved set. A short verifier is
  // brute-forceable, which is the one thing the length rule is there to stop.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Redirect URIs ───────────────────────────────────────────────────────────

/**
 * Exact string match against what the client registered. No prefix matching,
 * no wildcards, no "same origin is good enough".
 *
 * Every relaxation of this rule is a known attack: a prefix match lets
 * `https://good.example/cb.evil.com` through, an origin match lets any open
 * redirect on the client's own domain forward the code onwards. The URI the
 * code is sent to is the whole security boundary of the authorization code
 * flow.
 */
export function redirectUriAllowed(requested: string, registered: string[]): boolean {
  if (!requested) return false;
  return registered.includes(requested);
}

/**
 * Whether a redirect URI may be registered at all.
 *
 * HTTPS everywhere, except loopback — which the spec allows because a local
 * client cannot hold a TLS certificate, and which Claude Code needs. A
 * loopback URI must not pin its port: the client picks a free one at runtime.
 */
export function redirectUriRegistrable(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  // A fragment is forbidden by OAuth 2.1 and is a classic way to smuggle data
  // past a comparison that only looks at the path.
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "localhost")) {
    return true;
  }
  // A private-use scheme (com.example.app:/callback) is how native clients
  // come back to themselves.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && u.protocol !== "http:" && u.protocol !== "https:";
}

// ── Scopes ──────────────────────────────────────────────────────────────────

export const SCOPES = ["mercato:read", "mercato:write"] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * What approving a scope actually allows, in the words of someone deciding.
 *
 * The write line has to keep pace with the write tools. It once said "change
 * categories and clear values", which was true when those were the only two —
 * but the set now creates projects from an uploaded file and starts
 * categorisation, verification and export runs, and a run spends real AI
 * credit. A consent screen that promises less than it grants is not consent,
 * so this names the costly part rather than leaving it to be discovered on a
 * bill.
 */
export const SCOPE_LABEL: Record<Scope, string> = {
  "mercato:read": "See your projects, products, templates and export readiness",
  "mercato:write":
    "Create projects, change categories and values, and start categorisation, "
    + "verification and export runs — which spend AI credit — on projects you own",
};

/**
 * Parse a requested scope string, dropping anything unrecognised.
 *
 * Unknown scopes are ignored rather than rejected, per OAuth 2.1 — but the
 * granted scope is always echoed back, so a client that asked for something
 * it did not get can see that it did not get it.
 */
export function parseScopes(raw: string | null | undefined): Scope[] {
  const want = new Set((raw ?? "").split(/[\s,]+/).filter(Boolean));
  const out = SCOPES.filter((s) => want.has(s));
  // Asking for nothing means read. A token with no scope at all would be a
  // credential that exists and can do nothing, which is only confusing.
  return out.length ? out : ["mercato:read"];
}

export function scopeString(scopes: Scope[]): string {
  return [...new Set(scopes)].sort().join(" ");
}

export function grantsScope(granted: string, needed: Scope): boolean {
  return granted.split(/\s+/).includes(needed);
}

// ── Resource indicators ─────────────────────────────────────────────────────

/**
 * RFC 8707. The token must be bound to the server it will be used at.
 *
 * The spec is emphatic: a server must only accept tokens issued for itself.
 * Without this a token minted for some other MCP server, by an authorization
 * server a user also trusts, could be replayed here.
 *
 * Compared with the trailing slash ignored and scheme/host lowercased, which
 * RFC 8707 asks implementations to tolerate — a client that sends
 * `HTTPS://Host/api/mcp` is being clumsy, not hostile.
 */
export function resourceMatches(requested: string | null | undefined, canonical: string): boolean {
  if (!requested) return true; // absent is tolerated; wrong is not
  const norm = (s: string) => {
    try {
      const u = new URL(s);
      if (u.hash) return null;
      const path = u.pathname.replace(/\/+$/, "");
      return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}`;
    } catch {
      return null;
    }
  };
  const a = norm(requested);
  const b = norm(canonical);
  return a !== null && b !== null && a === b;
}

// ── Lifetimes ───────────────────────────────────────────────────────────────

/** Short, because an access token cannot be withdrawn before it expires. */
export const ACCESS_TTL_MS = 60 * 60 * 1000;
/**
 * An authorization code is alive only long enough to be redeemed. The spec
 * says a maximum of ten minutes and recommends less; the exchange happens in
 * the same second the browser redirects.
 */
export const CODE_TTL_MS = 60 * 1000;
/** Refresh tokens are the durable credential, and revoking one is the point. */
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function expired(at: Date | null | undefined, now = Date.now()): boolean {
  return !at || at.getTime() <= now;
}
