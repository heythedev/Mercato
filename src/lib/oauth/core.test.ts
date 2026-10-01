import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  ACCESS_TTL_MS,
  CODE_TTL_MS,
  SCOPES,
  expired,
  grantsScope,
  hashSecret,
  newSecret,
  parseScopes,
  redirectUriAllowed,
  redirectUriRegistrable,
  resourceMatches,
  scopeString,
  secretMatches,
  verifyPkce,
} from "./core";

/**
 * These are the checks that fail OPEN when they are wrong.
 *
 * A redirect URI matched loosely hands an authorization code to an attacker's
 * host. A PKCE check that does not actually hash defeats the exchange it
 * exists to protect. A code that can be redeemed twice is a replay. None of
 * them raise an error when broken — they simply permit — so each gets the
 * attack written down as a test rather than a comment.
 */

const challengeFor = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");
const goodVerifier = () => randomBytes(40).toString("base64url"); // 54 chars

describe("PKCE", () => {
  it("accepts the verifier that produced the challenge", () => {
    const v = goodVerifier();
    expect(verifyPkce(v, challengeFor(v))).toBe(true);
  });

  it("rejects any other verifier", () => {
    const v = goodVerifier();
    expect(verifyPkce(goodVerifier(), challengeFor(v))).toBe(false);
  });

  it("refuses the plain method outright", () => {
    // `plain` makes the challenge equal the verifier, so anyone who saw the
    // authorization request can finish the exchange. OAuth 2.1 requires S256
    // and we have only public clients.
    const v = goodVerifier();
    expect(verifyPkce(v, v, "plain")).toBe(false);
    expect(verifyPkce(v, challengeFor(v), "plain")).toBe(false);
  });

  it("refuses a verifier short enough to brute-force", () => {
    const short = "abc";
    expect(verifyPkce(short, challengeFor(short))).toBe(false);
  });

  it("refuses a verifier longer than the spec allows", () => {
    const long = "a".repeat(129);
    expect(verifyPkce(long, challengeFor(long))).toBe(false);
  });

  it("refuses characters outside the unreserved set", () => {
    const bad = "a".repeat(42) + "/";
    expect(verifyPkce(bad, challengeFor(bad))).toBe(false);
  });

  it("does not accept an empty or missing challenge", () => {
    const v = goodVerifier();
    expect(verifyPkce(v, "")).toBe(false);
    expect(verifyPkce(v, undefined as unknown as string)).toBe(false);
  });
});

describe("redirect URIs", () => {
  const registered = ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:8976/callback"];

  it("accepts exactly what was registered", () => {
    expect(redirectUriAllowed(registered[0], registered)).toBe(true);
  });

  it("refuses a prefix match — the classic code-stealing trick", () => {
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback.evil.com", registered)).toBe(false);
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback/../x", registered)).toBe(false);
  });

  it("refuses a different host on the same path", () => {
    expect(redirectUriAllowed("https://evil.example/api/mcp/auth_callback", registered)).toBe(false);
  });

  it("refuses an added query or fragment", () => {
    expect(redirectUriAllowed(registered[0] + "?x=1", registered)).toBe(false);
    expect(redirectUriAllowed(registered[0] + "#x", registered)).toBe(false);
  });

  it("refuses nothing at all", () => {
    expect(redirectUriAllowed("", registered)).toBe(false);
  });
});

describe("which redirect URIs may be registered", () => {
  it("allows https", () => {
    expect(redirectUriRegistrable("https://claude.ai/cb")).toBe(true);
  });

  it("allows loopback over http, because a local client has no certificate", () => {
    expect(redirectUriRegistrable("http://127.0.0.1:8976/cb")).toBe(true);
    expect(redirectUriRegistrable("http://localhost:3000/cb")).toBe(true);
  });

  it("refuses plain http anywhere else", () => {
    // Over the open internet this would put the code on the wire.
    expect(redirectUriRegistrable("http://claude.ai/cb")).toBe(false);
    expect(redirectUriRegistrable("http://192.168.1.5/cb")).toBe(false);
  });

  it("refuses a fragment", () => {
    expect(redirectUriRegistrable("https://claude.ai/cb#frag")).toBe(false);
  });

  it("allows a private-use scheme for a native client", () => {
    expect(redirectUriRegistrable("com.example.app:/callback")).toBe(true);
  });

  it("refuses nonsense", () => {
    expect(redirectUriRegistrable("not a url")).toBe(false);
    expect(redirectUriRegistrable("")).toBe(false);
  });
});

describe("scopes", () => {
  it("keeps only the ones that exist", () => {
    expect(parseScopes("mercato:read mercato:write")).toEqual(["mercato:read", "mercato:write"]);
    expect(parseScopes("mercato:read admin:everything")).toEqual(["mercato:read"]);
  });

  it("defaults to read rather than to nothing", () => {
    // A token with no scope is a credential that exists and can do nothing,
    // which only produces a confusing support ticket.
    expect(parseScopes("")).toEqual(["mercato:read"]);
    expect(parseScopes(null)).toEqual(["mercato:read"]);
    expect(parseScopes("nonsense")).toEqual(["mercato:read"]);
  });

  it("never invents write from a malformed request", () => {
    for (const raw of ["write", "mercato:*", "*", "mercato:read,write", "MERCATO:WRITE"]) {
      expect(parseScopes(raw), raw).not.toContain("mercato:write");
    }
  });

  it("round-trips through the stored string", () => {
    const s = scopeString(["mercato:write", "mercato:read"]);
    expect(grantsScope(s, "mercato:read")).toBe(true);
    expect(grantsScope(s, "mercato:write")).toBe(true);
  });

  it("a read-only grant does not grant write", () => {
    expect(grantsScope("mercato:read", "mercato:write")).toBe(false);
  });

  it("is not fooled by a scope that merely contains another", () => {
    expect(grantsScope("mercato:read-only", "mercato:read")).toBe(false);
  });

  it("offers exactly two, because a consent screen nobody reads is not consent", () => {
    expect(SCOPES).toHaveLength(2);
  });
});

describe("resource binding", () => {
  const canonical = "https://mercato-gray.vercel.app/api/mcp";

  it("accepts our own canonical URI", () => {
    expect(resourceMatches(canonical, canonical)).toBe(true);
  });

  it("tolerates clumsy casing and a trailing slash", () => {
    expect(resourceMatches("HTTPS://Mercato-Gray.Vercel.App/api/mcp", canonical)).toBe(true);
    expect(resourceMatches(canonical + "/", canonical)).toBe(true);
  });

  it("refuses another server's URI", () => {
    // The attack: a token minted for someone else's MCP server, replayed here.
    expect(resourceMatches("https://evil.example/api/mcp", canonical)).toBe(false);
    expect(resourceMatches("https://mercato-gray.vercel.app/api/other", canonical)).toBe(false);
  });

  it("refuses a fragment or junk", () => {
    expect(resourceMatches(canonical + "#x", canonical)).toBe(false);
    expect(resourceMatches("not a url", canonical)).toBe(false);
  });

  it("tolerates its absence, since not every client sends one", () => {
    expect(resourceMatches(null, canonical)).toBe(true);
    expect(resourceMatches(undefined, canonical)).toBe(true);
  });
});

describe("secrets", () => {
  it("never stores anything usable", () => {
    const s = newSecret("mrc_a_");
    expect(hashSecret(s)).not.toContain(s);
    expect(hashSecret(s)).toHaveLength(64);
  });

  it("matches only itself", () => {
    const s = newSecret("mrc_a_");
    expect(secretMatches(s, hashSecret(s))).toBe(true);
    expect(secretMatches(newSecret("mrc_a_"), hashSecret(s))).toBe(false);
  });

  it("survives a garbage comparison without throwing", () => {
    // timingSafeEqual throws on a length mismatch, which would turn a bad
    // token into a 500 instead of a 401.
    expect(secretMatches("", "short")).toBe(false);
    expect(secretMatches("x", "")).toBe(false);
  });

  it("is long enough not to be guessed", () => {
    expect(newSecret("mrc_a_").length).toBeGreaterThan(40);
    expect(new Set(Array.from({ length: 200 }, () => newSecret("mrc_a_"))).size).toBe(200);
  });
});

describe("lifetimes", () => {
  it("expires an authorization code in well under the spec's ceiling", () => {
    // Ten minutes is the maximum allowed; the exchange happens immediately,
    // so anything longer is just a window for a stolen code.
    expect(CODE_TTL_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it("keeps access tokens short, because they cannot be withdrawn early", () => {
    expect(ACCESS_TTL_MS).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it("treats a missing expiry as expired, not as forever", () => {
    expect(expired(null)).toBe(true);
    expect(expired(undefined)).toBe(true);
    expect(expired(new Date(Date.now() - 1))).toBe(true);
    expect(expired(new Date(Date.now() + 60_000))).toBe(false);
  });
});
