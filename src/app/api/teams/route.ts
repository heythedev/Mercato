import { NextRequest, NextResponse } from "next/server";
import { adminGuard, anyAdminGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { actorOf, isAdmin } from "@/lib/authz";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";

export const dynamic = "force-dynamic";

const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);

/**
 * Teams.
 *
 * Creating one, and moving people between them, is the super admin's alone: a
 * team admin who could do either would be able to walk out of their own scope.
 * A team admin may still READ the list, because the users screen shows which
 * team each member belongs to.
 */
export async function GET() {
  const { user, response } = await anyAdminGuard();
  if (response) return response;
  const actor = actorOf(user);

  const teams = await prisma.team.findMany({
    // A team admin has no business enumerating the other teams.
    where: isAdmin(actor) ? {} : { id: actor.teamId ?? "" },
    select: {
      id: true,
      name: true,
      slug: true,
      allowedMarketplaces: true,
      _count: { select: { users: true, projects: true } },
    },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ teams, canManage: isAdmin(actor) });
}

export async function POST(req: NextRequest) {
  const { response } = await adminGuard();
  if (response) return response;

  const body = (await req.json().catch(() => ({}))) as {
    name?: string;
    allowedMarketplaces?: unknown;
  };
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "Team name is required" }, { status: 400 });

  const slug = slugify(name);
  if (!slug) {
    return NextResponse.json({ error: "That name has no usable letters or digits" }, { status: 400 });
  }
  if (await prisma.team.findUnique({ where: { slug }, select: { id: true } })) {
    return NextResponse.json({ error: `A team called "${name}" already exists` }, { status: 409 });
  }

  // The team's ceiling. A team admin may grant its members any subset of this
  // and never anything outside it, so an empty list would lock the team out of
  // creating any project at all — default to everything and narrow deliberately.
  const requested = Array.isArray(body.allowedMarketplaces)
    ? (body.allowedMarketplaces as unknown[]).filter(
        (m): m is string => typeof m === "string" && MARKETPLACE_IDS.includes(m),
      )
    : null;

  const team = await prisma.team.create({
    data: { name, slug, allowedMarketplaces: requested ?? [...MARKETPLACE_IDS] },
    select: {
      id: true,
      name: true,
      slug: true,
      allowedMarketplaces: true,
      _count: { select: { users: true, projects: true } },
    },
  });

  return NextResponse.json({ team });
}

export async function PATCH(req: NextRequest) {
  const { response } = await adminGuard();
  if (response) return response;

  const body = (await req.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    allowedMarketplaces?: unknown;
  };
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const data: { name?: string; allowedMarketplaces?: string[] } = {};
  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
  if (Array.isArray(body.allowedMarketplaces)) {
    data.allowedMarketplaces = [
      ...new Set(
        (body.allowedMarketplaces as unknown[]).filter(
          (m): m is string => typeof m === "string" && MARKETPLACE_IDS.includes(m),
        ),
      ),
    ];
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const team = await prisma.team.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      slug: true,
      allowedMarketplaces: true,
      _count: { select: { users: true, projects: true } },
    },
  });
  return NextResponse.json({ team });
}

export async function DELETE(req: NextRequest) {
  const { response } = await adminGuard();
  if (response) return response;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  // Deleting a team must not delete its work. Every relation is onDelete:
  // SetNull, so its users, projects and templates survive as unassigned — which
  // is recoverable, unlike a cascade.
  const counts = await prisma.team.findUnique({
    where: { id },
    select: { _count: { select: { users: true, projects: true } } },
  });
  if (!counts) return NextResponse.json({ ok: true });

  await prisma.team.delete({ where: { id } });
  return NextResponse.json({
    ok: true,
    unassigned: { users: counts._count.users, projects: counts._count.projects },
  });
}
