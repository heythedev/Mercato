import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth-helpers";
import { actorOf, isAdmin, isTeamAdmin } from "@/lib/authz";
import { listInstructions, MAX_INSTRUCTION_CHARS } from "@/lib/marketplaces/instructions";
import { correctionSummary } from "@/lib/export/corrections";
import { prisma } from "@/lib/db";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";
import { InstructionsClient } from "@/components/admin/instructions-client";

export const dynamic = "force-dynamic";

/**
 * Where a standing rule gets written down.
 *
 * Resolved here rather than fetched on mount, like the other admin screens:
 * the page renders complete instead of flashing empty, and the client needs
 * no effect to populate itself.
 */
export default async function InstructionsPage() {
  const user = await requireUser();
  const actor = actorOf(user);
  if (!isAdmin(actor) && !isTeamAdmin(actor)) redirect("/projects");

  const [instructions, corrections, columnRules] = await Promise.all([
    listInstructions(actor.teamId).catch(() => []),
    // Nothing is recorded until the migration runs, and a screen that 500s
    // because a table is not there yet is worse than one showing none.
    correctionSummary().catch(() => []),
    prisma.marketplaceColumnRule
      .findMany({
        where: { OR: [{ teamId: null }, ...(actor.teamId ? [{ teamId: actor.teamId }] : [])] },
        orderBy: [{ marketplace: "asc" }, { createdAt: "asc" }],
      })
      .catch(() => []),
  ]);

  return (
    <InstructionsClient
      marketplaces={[...MARKETPLACE_IDS]}
      maxChars={MAX_INSTRUCTION_CHARS}
      canEditGlobal={isAdmin(actor)}
      teamId={actor.teamId}
      instructions={instructions.map((i) => ({ ...i, updatedAt: i.updatedAt.toISOString() }))}
      corrections={corrections}
      columnRules={columnRules.map((r) => ({
        id: r.id,
        marketplace: r.marketplace,
        teamId: r.teamId,
        column: r.column,
        action: r.action,
        find: r.find,
        value: r.value,
        note: r.note,
      }))}
    />
  );
}
