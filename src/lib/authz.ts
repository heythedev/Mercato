import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Who may see and do what.
 *
 * Every one of these rules used to be written inline at the point of use —
 * `where: { userId: user.id }` in one route, `project.userId !== user.id &&
 * role !== "admin"` in another, across fifteen files and forty-odd project
 * queries. Nothing enforced that they agreed, and a missed one does not throw:
 * it quietly returns the wrong rows.
 *
 * So the decision lives here, once. Routes ask a question ("may this actor read
 * this project?") instead of restating the answer. That matters immediately —
 * the inconsistencies below were found by writing this file — and it is what
 * makes a future change of scope (per-team isolation, say) a change to this
 * module rather than an audit of every caller.
 *
 * Deliberately NOT a behaviour change: each helper reproduces exactly what its
 * call sites did before, including where they disagreed with each other. The
 * disagreements are documented rather than silently resolved, because picking a
 * winner is a product decision, not a refactor.
 */

/** The acting user, narrowed to what any authorization decision actually needs. */
export type Actor = { id: string; role: string; teamId: string | null };

/**
 * Roles, widest first.
 *
 *   admin      — the super admin. Sees every team; predates teams and is
 *                deliberately not renamed, so no existing row needs migrating.
 *   team_admin — administers ONE team: its people, its templates, its export
 *                defaults, its marketplace access, and its spend.
 *   user       — their own projects only.
 */
export const ROLES = ["user", "team_admin", "admin"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Build an Actor from a NextAuth session user.
 *
 * The session user is typed loosely across the app (`(user as { role?: string
 * }).role` appears a dozen times), so the cast is done here once rather than at
 * every call site. An absent role means the least privilege, never the most.
 */
export function actorOf(user: unknown): Actor {
  const u = (user ?? {}) as { id?: string; role?: string; teamId?: string | null };
  return { id: u.id ?? "", role: u.role ?? "user", teamId: u.teamId ?? null };
}

/** The super admin: every team, every screen. */
export function isAdmin(actor: Actor): boolean {
  return actor.role === "admin";
}

/** Administers their own team — and only while they actually have one. */
export function isTeamAdmin(actor: Actor): boolean {
  return actor.role === "team_admin" && !!actor.teamId;
}

/** Either kind of admin. Use when the question is "may administer something". */
export function isAnyAdmin(actor: Actor): boolean {
  return isAdmin(actor) || isTeamAdmin(actor);
}

/**
 * Whether `actor` may act on something belonging to `teamId`.
 *
 * The super admin may act on anything. A team admin may act within their own
 * team. Everyone else, never — team membership alone grants nothing
 * administrative.
 */
export function sharesTeam(actor: Actor, teamId: string | null | undefined): boolean {
  if (isAdmin(actor)) return true;
  return isTeamAdmin(actor) && !!teamId && teamId === actor.teamId;
}

// ── Projects ─────────────────────────────────────────────────────────────────

/**
 * The `where` clause for LISTING projects.
 *
 *   user       — their own.
 *   team_admin — everything their team owns, theirs included.
 *   admin      — everything.
 *
 * This DOES change what a super admin's list shows. Before teams it was
 * owner-scoped for everyone, so an admin saw only the projects they had created
 * even though {@link canReadProject} let them open anyone's by id. That
 * asymmetry made sense when "admin" was the only way to say "can see more";
 * with a team_admin role covering the middle ground, a super admin's list
 * showing every project is the honest reading of the role.
 */
export function projectListScope(actor: Actor): Prisma.ProjectWhereInput {
  if (isAdmin(actor)) return {};
  if (isTeamAdmin(actor)) return { OR: [{ teamId: actor.teamId }, { userId: actor.id }] };
  return { userId: actor.id };
}

/** May this actor open a project and read its products? */
export function canReadProject(
  actor: Actor,
  project: { userId: string; teamId?: string | null },
): boolean {
  if (project.userId === actor.id) return true;
  return sharesTeam(actor, project.teamId ?? null);
}

/**
 * May this actor delete a project? The OWNER only — admins included in the
 * prohibition.
 *
 * This is not an oversight being carried forward blindly: DELETE
 * /api/projects/[id] checked ownership alone while its own GET admitted admins,
 * and the bulk DELETE /api/projects scoped `deleteMany` to the caller's id. All
 * three agree that deletion is the owner's alone, so that is the rule. If you
 * want admins to be able to delete, change it HERE and all three follow.
 */
export function canDeleteProject(actor: Actor, project: { userId: string }): boolean {
  return project.userId === actor.id;
}

/** The `where` clause for a bulk delete — never widens past what the actor owns. */
export function projectDeleteScope(actor: Actor): Prisma.ProjectWhereInput {
  return { userId: actor.id };
}

/**
 * May this actor RUN work on a project — verify, categorize, export — and read
 * that work's progress?
 *
 * Owner only, and deliberately narrower than {@link canReadProject}: an admin
 * may open someone's project to look at it, but starting a run on it would
 * spend that user's credits under the admin's hand and write results into their
 * catalogue. Twelve route handlers each enforced this with their own copy of
 * `project.userId !== user.id`; this is that same rule, named.
 */
export function canOperateProject(actor: Actor, project: { userId: string }): boolean {
  return project.userId === actor.id;
}

/** The team to stamp on a new project — whatever team its creator belongs to. */
export function teamIdForNewRow(actor: Actor): string | null {
  return actor.teamId ?? null;
}

/** May this actor poll or download an export job? Its creator only. */
export function canReadJob(actor: Actor, job: { userId: string }): boolean {
  return job.userId === actor.id;
}

// ── Templates ────────────────────────────────────────────────────────────────

/**
 * Ids of every admin account.
 *
 * Templates uploaded by an admin are meant to be global, and the convention for
 * that is `userId: null`. Templates created before the convention was enforced
 * carry the admin's own id instead, so "global" means *either* — and three
 * separate call sites each ran this same query to find out. Not cached: a
 * stale list would keep showing a demoted admin's templates as global.
 */
export async function adminUserIds(): Promise<string[]> {
  const admins = await prisma.user.findMany({ where: { role: "admin" }, select: { id: true } });
  return admins.map((u) => u.id);
}

/**
 * The OR clause selecting the templates an actor may use.
 *
 * The rule, in the order the clauses below express it:
 *   super admin  → every template there is, including each team's own
 *   anyone else  → their own, their team's, and the global ones
 *
 * "Global" means uploaded by the super admin: {@link ownerIdForNewTemplate}
 * stamps `userId: null` for an admin and the actor's own id for everyone else,
 * and {@link teamIdForNewRow} stamps the uploader's team. So a team admin's
 * upload stays inside that team and is shared with its members, and only the
 * super admin can publish to everyone.
 *
 * Pass the ids from {@link adminUserIds}; it is a separate query so a caller
 * that needs the ids for its own display logic does not run it twice.
 */
export function templateVisibilityOr(
  actor: Actor,
  adminIds: string[],
): Prisma.ExportTemplateWhereInput[] {
  // The super admin sees everything. Without this the account that administers
  // the system had the NARROWEST view of it: measured on live data the admin
  // saw 20 of 22 templates while every ordinary member of a team saw all 22 —
  // because the admin belongs to no team, so no team clause ever matched and
  // both of the team-owned templates were invisible to them.
  //
  // The always-true clause is an explicit predicate, NOT `{}`: Prisma drops an
  // empty object out of an OR array, leaving `OR: []`, which matches nothing at
  // all. That was measured too — it took the admin from 20 rows to 0. An id is
  // a cuid and is never the empty string, so this matches every row.
  if (isAdmin(actor)) return [{ id: { not: "" } }];

  return [
    { userId: actor.id },
    { userId: null },
    ...(adminIds.length > 0 ? [{ userId: { in: adminIds } }] : []),
    // A team's own templates, shared between its members. Guarded on teamId
    // being set: `{ teamId: null }` would match every pre-teams row and make
    // the whole library visible to everyone.
    ...(actor.teamId ? [{ teamId: actor.teamId }] : []),
  ];
}

/**
 * The owner to stamp on a newly created template: null for an admin, so it is
 * global from the start, and the actor's own id for everyone else.
 */
export function ownerIdForNewTemplate(actor: Actor): string | null {
  return isAdmin(actor) ? null : actor.id;
}

/** May this actor edit or delete a template? Its owner, or an admin over it. */
export function canWriteTemplate(
  actor: Actor,
  template: { userId: string | null; teamId?: string | null },
): boolean {
  if (template.userId === actor.id) return true;
  if (isAdmin(actor)) return true;
  // A team admin may manage their team's templates, but not the global ones —
  // those are shared with every other team.
  return isTeamAdmin(actor) && !!template.teamId && template.teamId === actor.teamId;
}

/**
 * Whether a template should be PRESENTED as global — it carries no owner, or
 * its owner is an admin. Drives the "Admin" badge and hides edit controls.
 */
export function isGlobalTemplate(template: { userId: string | null }, adminIds: Set<string>): boolean {
  return template.userId === null || adminIds.has(template.userId ?? "");
}

// ── Marketplaces ─────────────────────────────────────────────────────────────

/**
 * The marketplaces an actor may create projects for: everything for an admin,
 * and otherwise the explicit allow-list on their account. An empty list means
 * none — the list is an allow-list, so its absence grants nothing.
 */
export function allowedMarketplacesFor(
  actor: Actor,
  allMarketplaces: readonly string[],
  allowList: string[] | null | undefined,
): string[] {
  return isAdmin(actor) ? [...allMarketplaces] : (allowList ?? []);
}

/**
 * The marketplaces a team admin may grant to their members: their team's
 * ceiling, and never anything outside it.
 *
 * A team admin can widen a member up to what the team itself was given, which
 * is how "set marketplace access for their team" stays a delegated power rather
 * than a way to grant themselves more than the super admin allowed.
 */
export function grantableMarketplaces(
  actor: Actor,
  allMarketplaces: readonly string[],
  teamAllowList: string[] | null | undefined,
): string[] {
  if (isAdmin(actor)) return [...allMarketplaces];
  if (!isTeamAdmin(actor)) return [];
  const ceiling = new Set(teamAllowList ?? []);
  return allMarketplaces.filter((m) => ceiling.has(m));
}

/**
 * May this actor change that user's account — role, marketplaces, removal?
 *
 * A team admin manages their own team's members and may never touch a super
 * admin, another team's member, or promote anyone past their own role.
 */
export function canManageUser(
  actor: Actor,
  target: { id: string; role: string; teamId: string | null },
): boolean {
  if (isAdmin(actor)) return true;
  if (!isTeamAdmin(actor)) return false;
  if (target.id === actor.id) return false;
  if (target.role === "admin") return false;
  return !!target.teamId && target.teamId === actor.teamId;
}

/** Roles `actor` may assign. A team admin can never mint a super admin. */
export function assignableRoles(actor: Actor): Role[] {
  if (isAdmin(actor)) return [...ROLES];
  if (isTeamAdmin(actor)) return ["user", "team_admin"];
  return [];
}
