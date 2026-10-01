import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  SESSION_GAP_MS,
  groupIntoSessions,
  projectIdFromArgs,
  rowsFromResult,
  summariseByUser,
  type StoredCall,
} from "./usage";

/**
 * Turning a list of calls back into "what somebody did".
 *
 * MCP over HTTP has no session unless the client sends one, so a session is
 * reconstructed from gaps in time. Getting that wrong does not error — it
 * just reports a wrong number of sessions and a wrong duration, which is
 * worse than reporting nothing.
 */

let n = 0;
const at = (minutes: number, over: Partial<StoredCall> = {}): StoredCall => ({
  id: `c${n++}`,
  userId: "u1",
  tokenId: "tok1",
  sessionId: null,
  tool: "list_projects",
  projectId: null,
  ok: true,
  durationMs: 1000,
  rows: null,
  createdAt: new Date(Date.UTC(2026, 0, 1, 9, 0, 0) + minutes * 60_000),
  ...over,
});

describe("reconstructing sessions", () => {
  it("keeps a run of calls together", () => {
    const s = groupIntoSessions([at(0), at(2), at(5)]);
    expect(s).toHaveLength(1);
    expect(s[0].calls).toBe(3);
  });

  it("splits where somebody clearly stopped", () => {
    const s = groupIntoSessions([at(0), at(2), at(200), at(202)]);
    expect(s).toHaveLength(2);
    expect(s.map((x) => x.calls)).toEqual([2, 2]);
  });

  it("does not split on a long-running call", () => {
    // A 25-minute export check is still the same sitting.
    const s = groupIntoSessions([at(0), at(25)]);
    expect(s).toHaveLength(1);
  });

  it("keeps two people apart even at the same moment", () => {
    const s = groupIntoSessions([at(0), at(0, { userId: "u2", tokenId: "tok2" })]);
    expect(s).toHaveLength(2);
  });

  it("keeps one person's two laptops apart", () => {
    // Same user, different tokens — two devices, two sessions. Merging them
    // would report one impossible session spanning both.
    const s = groupIntoSessions([at(0), at(1, { tokenId: "tok2" })]);
    expect(s).toHaveLength(2);
  });

  it("trusts a client-supplied session id over the clock", () => {
    // A real session id means the client told us; a two-hour pause inside one
    // is still one session, and splitting it would contradict the client.
    const s = groupIntoSessions([at(0, { sessionId: "abc" }), at(200, { sessionId: "abc" })]);
    expect(s).toHaveLength(1);
    expect(s[0].calls).toBe(2);
  });

  it("counts the last call's own duration in the span", () => {
    // Otherwise a session ending on a 40-second check appears to end when
    // that check STARTED, and a single-call session lasts zero seconds.
    const one = groupIntoSessions([at(0, { durationMs: 40_000 })]);
    expect(one[0].spanMs).toBe(40_000);
  });

  it("separates time in tools from time elapsed", () => {
    // Twenty minutes apart, two seconds of work. Reporting the first as
    // "time using Mercato" would overstate it tenfold.
    const s = groupIntoSessions([at(0, { durationMs: 1000 }), at(20, { durationMs: 1000 })]);
    expect(s[0].spanMs).toBe(20 * 60_000 + 1000);
    expect(s[0].busyMs).toBe(2000);
  });

  it("describes the session by its tools, collapsing repeats", () => {
    const s = groupIntoSessions([
      at(0, { tool: "whoami" }),
      at(1, { tool: "list_projects" }),
      at(2, { tool: "find_products" }),
      at(3, { tool: "find_products" }),
      at(4, { tool: "export_readiness" }),
    ]);
    expect(s[0].trail).toEqual(["whoami", "list_projects", "find_products", "export_readiness"]);
  });

  it("collects the projects touched, once each", () => {
    const s = groupIntoSessions([
      at(0, { projectId: "p1" }),
      at(1, { projectId: "p1" }),
      at(2, { projectId: "p2" }),
      at(3),
    ]);
    expect(s[0].projectIds).toEqual(["p1", "p2"]);
  });

  it("adds up what was changed and what failed", () => {
    const s = groupIntoSessions([
      at(0, { tool: "submit_categorization", rows: 40 }),
      at(1, { tool: "submit_categorization", rows: 38 }),
      at(2, { ok: false }),
    ]);
    expect(s[0].rowsWritten).toBe(78);
    expect(s[0].failed).toBe(1);
  });

  it("uses a gap a person would recognise as stopping", () => {
    expect(SESSION_GAP_MS).toBe(30 * 60 * 1000);
  });

  it("returns newest first, because that is what anyone opens the page for", () => {
    const s = groupIntoSessions([at(0), at(500), at(1000)]);
    expect(s[0].startedAt.getTime()).toBeGreaterThan(s[s.length - 1].startedAt.getTime());
  });
});

describe("per-person totals", () => {
  it("adds sessions up and keeps the latest timestamp", () => {
    const calls = [at(0), at(2), at(300, { userId: "u2", tokenId: "tok2" })];
    const users = summariseByUser(groupIntoSessions(calls), calls);
    expect(users).toHaveLength(2);
    const u1 = users.find((u) => u.userId === "u1")!;
    expect(u1.sessions).toBe(1);
    expect(u1.calls).toBe(2);
  });

  it("names the tools somebody actually reaches for", () => {
    const calls = [
      at(0, { tool: "find_products" }),
      at(1, { tool: "find_products" }),
      at(2, { tool: "whoami" }),
    ];
    const [u] = summariseByUser(groupIntoSessions(calls), calls);
    expect(u.topTools[0]).toEqual({ tool: "find_products", calls: 2 });
  });
});

describe("what gets recorded off a call", () => {
  it("reads the project from the arguments, so a refused call still records one", () => {
    expect(projectIdFromArgs({ projectId: " p1 " })).toBe("p1");
    expect(projectIdFromArgs({ projectId: "" })).toBeNull();
    expect(projectIdFromArgs({})).toBeNull();
    expect(projectIdFromArgs({ projectId: 7 } as never)).toBeNull();
  });

  it("finds a row count in whichever shape the tool answered in", () => {
    expect(rowsFromResult(JSON.stringify({ written: 40 }))).toBe(40);
    expect(rowsFromResult(JSON.stringify({ changed: 12 }))).toBe(12);
    expect(rowsFromResult(JSON.stringify({ cleared: 3 }))).toBe(3);
  });

  it("reports null for a read, which is how reads and writes are told apart", () => {
    expect(rowsFromResult(JSON.stringify({ products: [1, 2, 3] }))).toBeNull();
    expect(rowsFromResult("not json at all")).toBeNull();
    expect(rowsFromResult(undefined)).toBeNull();
  });

  it("does not mistake a preview for a write", () => {
    // A preview reports wouldChange and writes nothing; counting it would
    // show rows changed that never were.
    expect(rowsFromResult(JSON.stringify({ preview: true, wouldChange: 31 }))).toBeNull();
  });
});
