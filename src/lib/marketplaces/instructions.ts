import { prisma } from "@/lib/db";
import { profileFor } from "./profile";

/**
 * Standing instructions for a marketplace, written by an admin and read by
 * every run.
 *
 * The problem this solves: nothing in Mercato learns, and Claude remembers
 * nothing between conversations. A correction given in a chat fixes one
 * project and then is gone — every rule this client discovered reached other
 * users only because somebody edited the exporter.
 *
 * So this is the place to write a rule down instead. It is not learning, and
 * calling it that would be a lie: it is a person stating a rule once, in a
 * place both Kimi and Claude read. The difference that matters is that the
 * next correction does not need a developer.
 *
 * What belongs here: how a description should read, which columns matter for
 * this marketplace, wording to avoid. What does NOT: a value that is the same
 * on every product — that is an export default, and a default is written into
 * the cell rather than suggested to a model, which is both cheaper and surer.
 */

/** How much instruction text is injected. Beyond this it stops being guidance
 *  and starts crowding out the product it is meant to describe — and on a
 *  large taxonomy the prompt has little room to spare. */
export const MAX_INSTRUCTION_CHARS = 2000;

export type MarketplaceInstruction = {
  marketplace: string;
  text: string;
  /** Null for the global rule, a team id for that team's override. */
  teamId: string | null;
  updatedAt: Date;
  updatedBy: string | null;
};

/**
 * The instruction in force for a marketplace, or null when none is set.
 *
 * A team's own row wins over the global one. Not merged: two sets of rules
 * concatenated is how a team ends up being told two contradictory things in
 * the same prompt, and the model picks whichever came last.
 */
export async function instructionFor(
  marketplace: string,
  teamId: string | null,
): Promise<string | null> {
  const id = profileFor(marketplace).id;
  try {
    const rows = await prisma.marketplaceInstruction.findMany({
      where: { marketplace: id, OR: [{ teamId: null }, ...(teamId ? [{ teamId }] : [])] },
      select: { text: true, teamId: true },
    });
    if (!rows.length) return null;
    const own = rows.find((r) => r.teamId && r.teamId === teamId);
    const text = (own ?? rows.find((r) => !r.teamId))?.text ?? "";
    const trimmed = text.trim();
    return trimmed ? trimmed.slice(0, MAX_INSTRUCTION_CHARS) : null;
  } catch (e) {
    // A missing table or an unreachable database must not stop a run. The
    // instruction is guidance; the run is the work.
    console.warn(`[instructions] could not load for ${id}:`, (e as Error).message);
    return null;
  }
}

/**
 * The instruction rendered for a prompt, or "" when there is none.
 *
 * Labelled as the operator's rule rather than dropped in as loose text, so a
 * model treats it as an instruction and not as part of the product data it is
 * being asked to classify.
 */
export function instructionBlock(text: string | null): string {
  if (!text) return "";
  return `\n\nHouse rules for this marketplace, from the account's administrator. Follow them unless they contradict the category list above, which always wins:\n${text}\n`;
}

/** Every instruction an admin screen should list. */
export async function listInstructions(teamId: string | null): Promise<MarketplaceInstruction[]> {
  const rows = await prisma.marketplaceInstruction.findMany({
    where: { OR: [{ teamId: null }, ...(teamId ? [{ teamId }] : [])] },
    orderBy: [{ marketplace: "asc" }],
  });
  return rows.map((r) => ({
    marketplace: r.marketplace,
    text: r.text,
    teamId: r.teamId,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy,
  }));
}

/**
 * Write or replace the instruction for a marketplace.
 *
 * An empty text DELETES the row rather than storing a blank one. A stored
 * empty string renders an empty "House rules" heading into every prompt,
 * which reads to a model as a rule it failed to understand.
 */
export async function setInstruction(args: {
  marketplace: string;
  teamId: string | null;
  text: string;
  updatedBy: string;
}): Promise<{ saved: boolean; cleared: boolean }> {
  const marketplace = profileFor(args.marketplace).id;
  const text = String(args.text ?? "").trim().slice(0, MAX_INSTRUCTION_CHARS);

  if (!text) {
    await prisma.marketplaceInstruction.deleteMany({
      where: { marketplace, teamId: args.teamId },
    });
    return { saved: false, cleared: true };
  }

  const existing = await prisma.marketplaceInstruction.findFirst({
    where: { marketplace, teamId: args.teamId },
    select: { id: true },
  });
  if (existing) {
    await prisma.marketplaceInstruction.update({
      where: { id: existing.id },
      data: { text, updatedBy: args.updatedBy },
    });
  } else {
    await prisma.marketplaceInstruction.create({
      data: { marketplace, teamId: args.teamId, text, updatedBy: args.updatedBy },
    });
  }
  return { saved: true, cleared: false };
}
