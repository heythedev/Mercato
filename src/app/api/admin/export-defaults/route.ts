import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { defaultKey } from "@/lib/export/defaults";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";

export const dynamic = "force-dynamic";

/**
 * Admin-only values for required export columns that no data source can answer.
 *
 *   GET    /api/admin/export-defaults            → every default, newest first
 *   PUT    /api/admin/export-defaults            → upsert one {marketplace, attribute, label, value}
 *   DELETE /api/admin/export-defaults?id=…       → remove one
 *
 * These exist so compliance declarations — Prop 65 warning type, the PFAS
 * statement — can be stated once by the seller instead of being asked of a
 * model per row. They were 64 of 462 empty required cells on the live Best Buy
 * project, and answering them here removes that many AI calls from every export.
 */
/**
 * True when the table has not been created yet. This database sits behind a
 * transaction pooler Prisma's migration engine cannot drive, so a deploy can
 * legitimately land before the table exists — the usage page shipped that way
 * and answered a bare HTTP 500. Report the state and the fix instead.
 */
async function tableMissing(): Promise<boolean> {
  const [{ n }] = await prisma.$queryRaw<{ n: bigint }[]>`
    select count(*) as n from information_schema.tables where table_name = 'ExportDefault'`;
  return Number(n) === 0;
}

const SETUP_COMMAND = "pnpm exec tsx scripts/apply-export-defaults-table.ts";

export async function GET() {
  const { response } = await adminGuard();
  if (response) return response;

  if (await tableMissing()) {
    return NextResponse.json({ defaults: [], setupRequired: true, setupCommand: SETUP_COMMAND });
  }

  const defaults = await prisma.exportDefault.findMany({
    orderBy: [{ marketplace: "asc" }, { attribute: "asc" }],
    select: { id: true, marketplace: true, attribute: true, label: true, value: true, updatedAt: true, updatedBy: true },
  });
  return NextResponse.json({ defaults });
}

export async function PUT(req: NextRequest) {
  const { user, response } = await adminGuard();
  if (response) return response;

  const body = (await req.json().catch(() => ({}))) as {
    marketplace?: string;
    attribute?: string;
    label?: string;
    value?: string;
  };

  const marketplace = String(body.marketplace ?? "").trim().toLowerCase();
  const rawAttribute = String(body.attribute ?? "").trim();
  const value = String(body.value ?? "").trim();

  if (!marketplace || !MARKETPLACE_IDS.includes(marketplace)) {
    return NextResponse.json({ error: "Unknown marketplace" }, { status: 400 });
  }
  if (!rawAttribute) return NextResponse.json({ error: "Attribute is required" }, { status: 400 });
  if (!value) return NextResponse.json({ error: "Value is required" }, { status: 400 });

  // Stored normalised so one entry answers the column whether the template names
  // it by label or by Mirakl code.
  const attribute = defaultKey(rawAttribute);
  if (!attribute) return NextResponse.json({ error: "Attribute is not a usable column name" }, { status: 400 });

  if (await tableMissing()) {
    return NextResponse.json({ error: `Not set up yet — run: ${SETUP_COMMAND}` }, { status: 503 });
  }

  const saved = await prisma.exportDefault.upsert({
    where: { marketplace_attribute: { marketplace, attribute } },
    create: {
      marketplace,
      attribute,
      label: body.label?.trim() || rawAttribute,
      value,
      updatedBy: (user as { email?: string })?.email ?? null,
    },
    update: {
      label: body.label?.trim() || rawAttribute,
      value,
      updatedBy: (user as { email?: string })?.email ?? null,
    },
    select: { id: true, marketplace: true, attribute: true, label: true, value: true, updatedAt: true, updatedBy: true },
  });

  return NextResponse.json({ default: saved });
}

export async function DELETE(req: NextRequest) {
  const { response } = await adminGuard();
  if (response) return response;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  await prisma.exportDefault.delete({ where: { id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
