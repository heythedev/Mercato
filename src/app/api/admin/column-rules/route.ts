import { NextRequest, NextResponse } from "next/server";
import { anyAdminGuard } from "@/lib/auth-helpers";
import { actorOf, isAdmin } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { isProtectedColumn, type ColumnRuleAction } from "@/lib/export/column-rules";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";
import { normalizeKey } from "@/lib/export/zip";

/**
 * Changes to a cell that a person states once and the exporter applies for
 * ever after.
 *
 * Scoped like the rest: the super admin writes the global rule, a team admin
 * writes their team's. A team's rules are ADDED to the global ones rather
 * than replacing them — a global rule usually says something must never ship,
 * and a team should not be able to switch that off by writing one of their
 * own.
 */

export const dynamic = "force-dynamic";

const ACTIONS: ColumnRuleAction[] = ["blank", "replace", "append"];

export async function GET() {
  const { user, response } = await anyAdminGuard();
  if (response) return response;
  const actor = actorOf(user);

  const rules = await prisma.marketplaceColumnRule.findMany({
    where: { OR: [{ teamId: null }, ...(actor.teamId ? [{ teamId: actor.teamId }] : [])] },
    orderBy: [{ marketplace: "asc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({ rules, canEditGlobal: isAdmin(actor), teamId: actor.teamId });
}

export async function POST(req: NextRequest) {
  const { user, response } = await anyAdminGuard();
  if (response) return response;
  const actor = actorOf(user);

  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const marketplace = String(b.marketplace ?? "").trim().toLowerCase();
  const column = String(b.column ?? "").trim();
  const action = String(b.action ?? "") as ColumnRuleAction;
  const find = String(b.find ?? "").trim();
  const value = String(b.value ?? "").trim();
  const note = String(b.note ?? "").trim();

  if (!MARKETPLACE_IDS.includes(marketplace)) {
    return NextResponse.json({ error: `No such marketplace: ${marketplace || "(none)"}` }, { status: 400 });
  }
  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ error: `action must be one of: ${ACTIONS.join(", ")}` }, { status: 400 });
  }
  if (!column) return NextResponse.json({ error: "Which column?" }, { status: 400 });

  // Refused here as well as at the point of use. A find-and-replace loose on
  // a barcode is not a formatting preference; it is a different product, and
  // it still looks like a barcode in the finished file.
  if (isProtectedColumn(column)) {
    return NextResponse.json(
      {
        error:
          `"${column}" is an identifier and cannot be changed by a rule. A barcode, SKU or MPN with `
          + "characters removed still looks like one in the file, and matches somebody else's listing.",
      },
      { status: 400 },
    );
  }
  if (action === "replace" && !find) {
    return NextResponse.json({ error: "A replace rule needs something to find" }, { status: 400 });
  }
  if (action === "append" && !value) {
    return NextResponse.json({ error: "An append rule needs the text to add" }, { status: 400 });
  }

  const teamId = isAdmin(actor) ? null : actor.teamId;
  if (!isAdmin(actor) && !teamId) {
    return NextResponse.json({ error: "No team to write a rule for" }, { status: 403 });
  }

  const rule = await prisma.marketplaceColumnRule.create({
    data: {
      marketplace,
      teamId,
      // Stored normalised so a rule written against "Product Description"
      // still matches a template whose header is "product_description".
      column: column === "*" ? "*" : normalizeKey(column),
      action,
      find: action === "replace" ? find : null,
      value: action === "blank" ? null : value,
      note: note || null,
      updatedBy: actor.id,
    },
  });

  return NextResponse.json({ rule });
}

export async function DELETE(req: NextRequest) {
  const { user, response } = await anyAdminGuard();
  if (response) return response;
  const actor = actorOf(user);

  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "Which rule?" }, { status: 400 });

  // The scope guard is the point: a team admin must not be able to delete the
  // global rule, or a rule belonging to another team, by passing its id.
  const where = isAdmin(actor) ? { id } : { id, teamId: actor.teamId };
  const { count } = await prisma.marketplaceColumnRule.deleteMany({ where });
  if (!count) return NextResponse.json({ error: "No such rule you can change" }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
