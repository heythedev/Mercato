import { NextRequest, NextResponse } from "next/server";
import { adminGuard, anyAdminGuard } from "@/lib/auth-helpers";
import {
  actorOf,
  assignableRoles,
  canManageUser,
  isAdmin,
  grantableMarketplaces,
  ROLES,
} from "@/lib/authz";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";

export async function GET() {
  const { user, response } = await anyAdminGuard();
  if (response) return response;

  const actor = actorOf(user);
  const users = await prisma.user.findMany({
    // A team admin administers one team and sees exactly that team.
    where: isAdmin(actor) ? {} : { teamId: actor.teamId },
    select: {
      id: true, name: true, email: true, role: true,
      allowedMarketplaces: true, createdAt: true, teamId: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  const { user: actorUser, response } = await anyAdminGuard();
  if (response) return response;

  const body = await req.json();
  const { name, email, password, role } = body;

  if (!email || !password) {
    return NextResponse.json({ error: "email and password required" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return NextResponse.json({ error: "User already exists" }, { status: 409 });

  const hash = await bcrypt.hash(password, 12);
  const actor = actorOf(actorUser);
  const wanted = typeof role === "string" ? role : "user";
  // A team admin may create users and team admins, never a super admin.
  if (!assignableRoles(actor).includes(wanted as (typeof ROLES)[number])) {
    return NextResponse.json({ error: "You cannot assign that role" }, { status: 403 });
  }

  const user = await prisma.user.create({
    data: {
      name: name ?? null,
      email,
      password: hash,
      role: wanted,
      // Into the creator's team. A super admin creates unassigned users and
      // places them from the team screen.
      teamId: isAdmin(actor) ? null : actor.teamId,
    },
    select: {
      id: true, name: true, email: true, role: true,
      allowedMarketplaces: true, createdAt: true, teamId: true,
    },
  });

  return NextResponse.json(user);
}

export async function DELETE(req: NextRequest) {
  const { user, response } = await anyAdminGuard();
  if (response) return response;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, teamId: true },
  });
  if (!target) return NextResponse.json({ ok: true });
  if (!canManageUser(actorOf(user), target)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await prisma.user.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const { user: actorUser, response } = await anyAdminGuard();
  if (response) return response;

  const body = await req.json();
  const { id, role, password, allowedMarketplaces, teamId } = body as {
    id?: string;
    role?: string;
    password?: string;
    allowedMarketplaces?: unknown;
    /** null moves the user out of every team. */
    teamId?: string | null;
  };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const actor = actorOf(actorUser);
  const target = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, teamId: true },
  });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!canManageUser(actor, target)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Build only the fields actually provided, so one endpoint handles role
  // changes, password resets, and marketplace-access edits independently.
  const data: {
    role?: string;
    password?: string;
    allowedMarketplaces?: string[];
    teamId?: string | null;
  } = {};

  if (teamId !== undefined) {
    // Moving someone between teams is the super admin's alone: a team admin who
    // could do it would be able to pull another team's member into their own
    // scope, or push a member out of reach.
    if (!isAdmin(actor)) {
      return NextResponse.json(
        { error: "Only a super admin can change which team a user belongs to" },
        { status: 403 },
      );
    }
    if (teamId !== null) {
      const team = await prisma.team.findUnique({ where: { id: teamId }, select: { id: true } });
      if (!team) return NextResponse.json({ error: "No such team" }, { status: 400 });
    }
    data.teamId = teamId;
  }

  if (typeof role === "string") {
    // A team admin may move someone between user and team_admin; only the
    // super admin can mint another super admin.
    if (!assignableRoles(actor).includes(role as (typeof ROLES)[number])) {
      return NextResponse.json({ error: "You cannot assign that role" }, { status: 403 });
    }
    data.role = role;
  }

  if (typeof password === "string") {
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }
    data.password = await bcrypt.hash(password, 12);
  }

  if (allowedMarketplaces !== undefined) {
    if (!Array.isArray(allowedMarketplaces) || allowedMarketplaces.some((m) => typeof m !== "string")) {
      return NextResponse.json({ error: "allowedMarketplaces must be a string array" }, { status: 400 });
    }
    // Keep only known ids and de-dupe — and, for a team admin, only what
    // their own team was granted. Otherwise "set marketplace access for their
    // team" would be a route to a marketplace the super admin never allowed.
    const team = actor.teamId
      ? await prisma.team.findUnique({
          where: { id: actor.teamId },
          select: { allowedMarketplaces: true },
        })
      : null;
    const grantable = new Set(
      grantableMarketplaces(actor, MARKETPLACE_IDS, team?.allowedMarketplaces),
    );
    data.allowedMarketplaces = [...new Set(
      (allowedMarketplaces as string[]).filter((m) => grantable.has(m)),
    )];
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const user = await prisma.user.update({
    where: { id },
    data,
    select: {
      id: true, name: true, email: true, role: true,
      allowedMarketplaces: true, createdAt: true, teamId: true,
    },
  });

  return NextResponse.json(user);
}
