import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * A token names a person, and that is the whole security model.
 *
 * The obvious design — one shared secret for the MCP endpoint — makes every
 * caller equally powerful and silently undoes every scope in authz.ts: a
 * member would reach a colleague's private templates, a team admin another
 * team's projects. All of that work would be bypassed through the one door
 * left open. So these pin the properties that stop it.
 */

const rows = new Map<string, Record<string, unknown>>();

vi.mock("@/lib/db", () => ({
  prisma: {
    mcpToken: {
      create: vi.fn(async ({ data, select }: { data: Record<string, unknown>; select: Record<string, boolean> }) => {
        const id = `t${rows.size + 1}`;
        rows.set(String(data.tokenHash), { id, ...data, revokedAt: null });
        return Object.fromEntries(Object.keys(select).map((k) => [k, k === "id" ? id : data[k]]));
      }),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => {
        const r = rows.get(where.tokenHash);
        if (!r) return null;
        return {
          id: r.id,
          tokenHash: r.tokenHash,
          revokedAt: r.revokedAt,
          user: { id: r.userId, role: "user", teamId: "team-a", email: "someone@example.com" },
        };
      }),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async ({ where }: { where: { id: string; userId: string; revokedAt: null } }) => {
        for (const r of rows.values()) {
          if (r.id === where.id && r.userId === where.userId && r.revokedAt === null) {
            r.revokedAt = new Date();
            return { count: 1 };
          }
        }
        return { count: 0 };
      }),
      findMany: vi.fn(async () => []),
    },
  },
}));

import { actorForToken, issueToken, revokeToken } from "./tokens";

beforeEach(() => rows.clear());

describe("MCP tokens", () => {
  it("resolves to the user it was issued for", async () => {
    const { token } = await issueToken("u1", "laptop");
    const auth = await actorForToken(`Bearer ${token}`);
    expect(auth?.actor.id).toBe("u1");
  });

  it("never stores the token itself", async () => {
    const { token } = await issueToken("u1", "laptop");
    const stored = [...rows.values()][0];
    // A database dump must not be a set of live credentials. That stopped
    // being theoretical the day backups started leaving the server.
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(String(stored.tokenHash)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("stores a prefix short enough to be useless on its own", async () => {
    const { token, prefix } = await issueToken("u1", "laptop");
    expect(token.startsWith(prefix)).toBe(true);
    // Enough to tell two tokens apart in a list; far too little to replay.
    expect(prefix.length).toBeLessThan(token.length / 3);
  });

  it("refuses a revoked token immediately", async () => {
    const { token, id } = await issueToken("u1", "laptop");
    expect(await actorForToken(`Bearer ${token}`)).not.toBeNull();
    expect(await revokeToken("u1", id)).toBe(true);
    // A revoke button that leaves the credential working is theatre.
    expect(await actorForToken(`Bearer ${token}`)).toBeNull();
  });

  it("will not let one person revoke another's token", async () => {
    const { id } = await issueToken("u1", "laptop");
    expect(await revokeToken("u2", id)).toBe(false);
  });

  it("refuses rubbish without touching the database", async () => {
    for (const bad of ["", "   ", "Bearer ", "not-a-token", "mrc_", "Bearer mrc_wrong"]) {
      expect(await actorForToken(bad)).toBeNull();
    }
    expect(await actorForToken(null)).toBeNull();
    expect(await actorForToken(undefined)).toBeNull();
  });

  it("accepts the token with or without the Bearer prefix", async () => {
    const { token } = await issueToken("u1", "laptop");
    expect(await actorForToken(token)).not.toBeNull();
    expect(await actorForToken(`Bearer ${token}`)).not.toBeNull();
    expect(await actorForToken(`bearer ${token}`)).not.toBeNull();
  });

  it("issues a different token every time", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) seen.add((await issueToken("u1", `t${i}`)).token);
    expect(seen.size).toBe(25);
  });
});
