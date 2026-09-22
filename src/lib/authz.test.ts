import { describe, it, expect, vi } from "vitest";

// authz imports prisma for adminUserIds(); nothing under test here touches the
// database, and a real client would try to read DATABASE_URL.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import {
  actorOf,
  allowedMarketplacesFor,
  assignableRoles,
  canDeleteProject,
  canManageUser,
  canOperateProject,
  canReadJob,
  canReadProject,
  canWriteTemplate,
  grantableMarketplaces,
  isAdmin,
  isAnyAdmin,
  isGlobalTemplate,
  isTeamAdmin,
  ownerIdForNewTemplate,
  projectDeleteScope,
  projectListScope,
  sharesTeam,
  teamIdForNewRow,
  templateVisibilityOr,
} from "./authz";

const TEAM = "team-a";
const OTHER = "team-b";

const owner = { id: "u1", role: "user", teamId: TEAM };
const mate = { id: "u9", role: "user", teamId: TEAM };
const stranger = { id: "u2", role: "user", teamId: OTHER };
const teamAdmin = { id: "ta", role: "team_admin", teamId: TEAM };
const otherTeamAdmin = { id: "tb", role: "team_admin", teamId: OTHER };
const admin = { id: "a1", role: "admin", teamId: null };
const project = { userId: "u1", teamId: TEAM };

describe("actorOf", () => {
  it("defaults a missing role to the least privilege, never the most", () => {
    expect(actorOf({ id: "u1" })).toEqual({ id: "u1", role: "user", teamId: null });
    expect(isAdmin(actorOf({ id: "u1" }))).toBe(false);
  });

  it("survives a null or malformed session user", () => {
    expect(actorOf(null)).toEqual({ id: "", role: "user", teamId: null });
    expect(actorOf(undefined)).toEqual({ id: "", role: "user", teamId: null });
  });

  it("carries role and team through", () => {
    const a = actorOf({ id: "ta", role: "team_admin", teamId: TEAM });
    expect(isTeamAdmin(a)).toBe(true);
    expect(isAnyAdmin(a)).toBe(true);
  });

  it("does not treat a team_admin with no team as an admin of anything", () => {
    // The role alone grants nothing: without a team there is no scope for it to
    // be an admin OF, and treating it as one would be an unscoped privilege.
    const orphan = actorOf({ id: "x", role: "team_admin", teamId: null });
    expect(isTeamAdmin(orphan)).toBe(false);
    expect(isAnyAdmin(orphan)).toBe(false);
    expect(sharesTeam(orphan, TEAM)).toBe(false);
  });
});

describe("team boundaries", () => {
  it("lets a team admin act inside their own team and nowhere else", () => {
    expect(sharesTeam(teamAdmin, TEAM)).toBe(true);
    expect(sharesTeam(teamAdmin, OTHER)).toBe(false);
    expect(sharesTeam(teamAdmin, null)).toBe(false);
  });

  it("gives an ordinary member no administrative reach over their own team", () => {
    // Membership is not administration — otherwise every user would manage
    // every teammate's work.
    expect(sharesTeam(owner, TEAM)).toBe(false);
  });

  it("lets the super admin act anywhere, including on unassigned rows", () => {
    expect(sharesTeam(admin, TEAM)).toBe(true);
    expect(sharesTeam(admin, null)).toBe(true);
  });
});

describe("reading a project", () => {
  it("admits the owner", () => {
    expect(canReadProject(owner, project)).toBe(true);
  });

  it("admits the team's admin and the super admin", () => {
    expect(canReadProject(teamAdmin, project)).toBe(true);
    expect(canReadProject(admin, project)).toBe(true);
  });

  it("refuses another team's admin, and a teammate who is not an admin", () => {
    expect(canReadProject(otherTeamAdmin, project)).toBe(false);
    expect(canReadProject(mate, project)).toBe(false);
    expect(canReadProject(stranger, project)).toBe(false);
  });

  it("refuses a team admin on a project with no team", () => {
    // Pre-teams rows carry teamId null. Matching null against null would hand
    // every legacy project to whichever team admin asked first.
    expect(canReadProject(teamAdmin, { userId: "u1", teamId: null })).toBe(false);
    expect(canReadProject(admin, { userId: "u1", teamId: null })).toBe(true);
  });
});

describe("acting on a project", () => {
  // The owner alone may delete a project or start a paid run on it. Neither
  // admin is included: starting a run spends that user's credits and writes
  // results into their catalogue. If that should change it is a product
  // decision that updates this test, not a silent drift.
  it("keeps deletion to the owner, both admins included in the prohibition", () => {
    expect(canDeleteProject(owner, project)).toBe(true);
    expect(canDeleteProject(teamAdmin, project)).toBe(false);
    expect(canDeleteProject(admin, project)).toBe(false);
  });

  it("keeps verify/categorize/export runs to the owner", () => {
    expect(canOperateProject(owner, project)).toBe(true);
    expect(canOperateProject(teamAdmin, project)).toBe(false);
    expect(canOperateProject(admin, project)).toBe(false);
  });

  it("keeps export jobs to their creator", () => {
    expect(canReadJob(owner, { userId: "u1" })).toBe(true);
    expect(canReadJob(admin, { userId: "u1" })).toBe(false);
  });
});

describe("project list scope", () => {
  it("shows a user only their own", () => {
    expect(projectListScope(owner)).toEqual({ userId: "u1" });
  });

  it("shows a team admin their whole team", () => {
    expect(projectListScope(teamAdmin)).toEqual({
      OR: [{ teamId: TEAM }, { userId: "ta" }],
    });
  });

  it("shows the super admin everything", () => {
    expect(projectListScope(admin)).toEqual({});
  });

  it("never widens a bulk delete past what the actor owns", () => {
    // Deletion is the owner's alone, so the scope must not follow the list.
    expect(projectDeleteScope(admin)).toEqual({ userId: "a1" });
    expect(projectDeleteScope(teamAdmin)).toEqual({ userId: "ta" });
  });
});

describe("template visibility", () => {
  it("selects own, global, admin-owned and the actor's team", () => {
    expect(templateVisibilityOr(owner, ["a1"])).toEqual([
      { userId: "u1" },
      { userId: null },
      { userId: { in: ["a1"] } },
      { teamId: TEAM },
    ]);
  });

  it("omits the team clause when the actor has no team", () => {
    // `{ teamId: null }` would match every row written before teams existed and
    // expose the whole library.
    expect(templateVisibilityOr(admin, [])).toEqual([{ userId: "a1" }, { userId: null }]);
  });

  it("omits the admin clause entirely when there are no admins", () => {
    expect(templateVisibilityOr({ ...owner, teamId: null }, [])).toEqual([
      { userId: "u1" },
      { userId: null },
    ]);
  });

  it("makes an admin's new template global and a user's private", () => {
    expect(ownerIdForNewTemplate(admin)).toBeNull();
    expect(ownerIdForNewTemplate(owner)).toBe("u1");
  });

  it("lets a team admin edit their team's template but not a global one", () => {
    // A global template is shared with every other team; editing it from inside
    // one team would change what the others export.
    expect(canWriteTemplate(teamAdmin, { userId: "u1", teamId: TEAM })).toBe(true);
    expect(canWriteTemplate(teamAdmin, { userId: null, teamId: null })).toBe(false);
    expect(canWriteTemplate(teamAdmin, { userId: "u2", teamId: OTHER })).toBe(false);
    expect(canWriteTemplate(admin, { userId: null, teamId: null })).toBe(true);
  });

  it("presents both the null-owner and admin-owned cases as global", () => {
    const admins = new Set(["a1"]);
    expect(isGlobalTemplate({ userId: null }, admins)).toBe(true);
    expect(isGlobalTemplate({ userId: "a1" }, admins)).toBe(true);
    expect(isGlobalTemplate({ userId: "u1" }, admins)).toBe(false);
  });
});

describe("new rows inherit their creator's team", () => {
  it("stamps the actor's team, or nothing for the super admin", () => {
    expect(teamIdForNewRow(owner)).toBe(TEAM);
    expect(teamIdForNewRow(admin)).toBeNull();
  });
});

describe("marketplace access", () => {
  const ALL = ["amazon", "walmart", "bestbuy"] as const;

  it("gives an admin every marketplace", () => {
    expect(allowedMarketplacesFor(admin, ALL, [])).toEqual([...ALL]);
  });

  it("gives everyone else exactly their allow-list", () => {
    expect(allowedMarketplacesFor(owner, ALL, ["walmart"])).toEqual(["walmart"]);
  });

  it("treats an absent allow-list as granting nothing", () => {
    expect(allowedMarketplacesFor(owner, ALL, null)).toEqual([]);
    expect(allowedMarketplacesFor(owner, ALL, undefined)).toEqual([]);
  });

  it("caps what a team admin can grant at their team's own ceiling", () => {
    // Otherwise "set marketplace access for their team" would be a way to hand
    // themselves a marketplace the super admin never gave the team.
    expect(grantableMarketplaces(teamAdmin, ALL, ["walmart", "bestbuy"])).toEqual([
      "walmart",
      "bestbuy",
    ]);
    expect(grantableMarketplaces(teamAdmin, ALL, [])).toEqual([]);
    expect(grantableMarketplaces(owner, ALL, ["walmart"])).toEqual([]);
    expect(grantableMarketplaces(admin, ALL, [])).toEqual([...ALL]);
  });
});

describe("managing people", () => {
  const member = { id: "u1", role: "user", teamId: TEAM };

  it("lets a team admin manage their own team's members", () => {
    expect(canManageUser(teamAdmin, member)).toBe(true);
  });

  it("refuses another team's member and anyone with no team", () => {
    expect(canManageUser(teamAdmin, { id: "u2", role: "user", teamId: OTHER })).toBe(false);
    expect(canManageUser(teamAdmin, { id: "u3", role: "user", teamId: null })).toBe(false);
  });

  it("never lets a team admin touch a super admin", () => {
    expect(canManageUser(teamAdmin, { id: "a1", role: "admin", teamId: TEAM })).toBe(false);
  });

  it("stops a team admin editing their own account", () => {
    // Self-edit is how a scoped role escapes its scope.
    expect(canManageUser(teamAdmin, { id: "ta", role: "team_admin", teamId: TEAM })).toBe(false);
  });

  it("never lets a team admin mint a super admin", () => {
    expect(assignableRoles(teamAdmin)).toEqual(["user", "team_admin"]);
    expect(assignableRoles(admin)).toEqual(["user", "team_admin", "admin"]);
    expect(assignableRoles(owner)).toEqual([]);
  });
});
