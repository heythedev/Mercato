import { NextRequest, NextResponse } from "next/server";
import { anyAdminGuard } from "@/lib/auth-helpers";
import { actorOf, isAdmin } from "@/lib/authz";
import { listInstructions, setInstruction, MAX_INSTRUCTION_CHARS } from "@/lib/marketplaces/instructions";
import { correctionSummary } from "@/lib/export/corrections";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";

/**
 * Standing rules per marketplace, and the corrections that suggest the rules
 * nobody has written yet.
 *
 * The two belong on one screen because they are two ends of the same loop:
 * what a person told the system to do, and what people keep having to undo.
 * Reading the second is how you decide what to put in the first.
 *
 * Scoped like the other admin screens. A team admin writes their own team's
 * rule and never the global one — a team admin who could edit the global rule
 * would be changing how every other team's exports behave, which is exactly
 * the scope escape the rest of authz spends its time preventing.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const { user, response } = await anyAdminGuard();
  if (response) return response;
  const actor = actorOf(user);

  const [instructions, corrections] = await Promise.all([
    listInstructions(actor.teamId),
    // What is being corrected, so an admin can see which columns are worth
    // writing a rule about rather than guessing.
    correctionSummary().catch(() => []),
  ]);

  return NextResponse.json({
    marketplaces: MARKETPLACE_IDS,
    maxChars: MAX_INSTRUCTION_CHARS,
    // A team admin edits their team's row; the global one is shown but not
    // editable, because it is somebody else's decision about every team.
    canEditGlobal: isAdmin(actor),
    teamId: actor.teamId,
    instructions,
    corrections,
  });
}

export async function PUT(req: NextRequest) {
  const { user, response } = await anyAdminGuard();
  if (response) return response;
  const actor = actorOf(user);

  const body = (await req.json().catch(() => ({}))) as { marketplace?: string; text?: string };
  const marketplace = String(body.marketplace ?? "").trim().toLowerCase();
  if (!marketplace) return NextResponse.json({ error: "Which marketplace?" }, { status: 400 });
  if (!MARKETPLACE_IDS.includes(marketplace)) {
    return NextResponse.json({ error: `No such marketplace: ${marketplace}` }, { status: 400 });
  }

  // The super admin writes the global rule; a team admin writes their team's.
  // There is no parameter for WHOSE rule to write, so there is no way to write
  // somebody else's.
  const teamId = isAdmin(actor) ? null : actor.teamId;
  if (!isAdmin(actor) && !teamId) {
    return NextResponse.json({ error: "No team to write a rule for" }, { status: 403 });
  }

  const result = await setInstruction({
    marketplace,
    teamId,
    text: String(body.text ?? ""),
    updatedBy: actor.id,
  });

  return NextResponse.json({
    ...result,
    marketplace,
    scope: teamId ? "team" : "global",
  });
}
