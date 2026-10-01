import { requireAnyAdmin } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { actorOf, isAdmin } from "@/lib/authz";
import { groupIntoSessions, recentCalls, summariseByUser } from "@/lib/mcp/usage";
import { PageHeader } from "@/components/ui/primitives";
import { McpUsageClient } from "@/components/admin/mcp-usage-client";

export const dynamic = "force-dynamic";

/**
 * Who has been using Claude against Mercato, and what they did.
 *
 * Scoped like everything else: a super admin sees the whole deployment, a
 * team admin sees their own team. A member has no business here at all —
 * their own activity is their own, and the point of this page is oversight.
 */
export default async function McpUsagePage() {
  const account = await requireAnyAdmin();
  const actor = actorOf(account);

  const calls = await recentCalls(30);

  // A team admin sees their team; the super admin sees everyone.
  const visibleUsers = await prisma.user.findMany({
    where: isAdmin(actor) ? {} : { teamId: actor.teamId ?? "__none__" },
    select: { id: true, name: true, email: true, role: true },
  });
  const byId = new Map(visibleUsers.map((u) => [u.id, u]));
  const mine = calls.filter((c) => byId.has(c.userId));

  const sessions = groupIntoSessions(mine);
  const users = summariseByUser(sessions, mine);

  const projectIds = [...new Set(sessions.flatMap((s) => s.projectIds))];
  const projects = projectIds.length
    ? await prisma.project.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, name: true },
      })
    : [];

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <PageHeader
        title="Claude usage"
        subtitle="Who connected Claude to Mercato, how long they worked, and which tools they used. Mercato records the calls Claude makes — never the conversation itself."
      />
      <McpUsageClient
        users={users.map((u) => ({
          ...u,
          lastUsedAt: u.lastUsedAt.toISOString(),
          name: byId.get(u.userId)?.name ?? null,
          email: byId.get(u.userId)?.email ?? u.userId,
        }))}
        sessions={sessions.slice(0, 100).map((s) => ({
          ...s,
          startedAt: s.startedAt.toISOString(),
          endedAt: s.endedAt.toISOString(),
          email: byId.get(s.userId)?.email ?? s.userId,
        }))}
        projectNames={Object.fromEntries(projects.map((p) => [p.id, p.name]))}
      />
    </div>
  );
}
