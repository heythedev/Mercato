import { NextRequest, NextResponse } from "next/server";
import { adminGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";
import { MARKETPLACE_IDS } from "@/lib/marketplaces/catalog";

export async function GET() {
  const { response } = await adminGuard();
  if (response) return response;

  const users = await prisma.user.findMany({
    select: { id: true, name: true, email: true, role: true, allowedMarketplaces: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({ users });
}

export async function POST(req: NextRequest) {
  const { response } = await adminGuard();
  if (response) return response;

  const body = await req.json();
  const { name, email, password, role } = body;

  if (!email || !password) {
    return NextResponse.json({ error: "email and password required" }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return NextResponse.json({ error: "User already exists" }, { status: 409 });

  const hash = await bcrypt.hash(password, 12);
  const user = await prisma.user.create({
    data: { name: name ?? null, email, password: hash, role: role ?? "user" },
    select: { id: true, name: true, email: true, role: true, allowedMarketplaces: true, createdAt: true },
  });

  return NextResponse.json(user);
}

export async function DELETE(req: NextRequest) {
  const { response } = await adminGuard();
  if (response) return response;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await prisma.user.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: NextRequest) {
  const { response } = await adminGuard();
  if (response) return response;

  const body = await req.json();
  const { id, role, password, allowedMarketplaces } = body as {
    id?: string;
    role?: string;
    password?: string;
    allowedMarketplaces?: unknown;
  };
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  // Build only the fields actually provided, so one endpoint handles role
  // changes, password resets, and marketplace-access edits independently.
  const data: {
    role?: string;
    password?: string;
    allowedMarketplaces?: string[];
  } = {};

  if (typeof role === "string") data.role = role;

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
    // Keep only known ids and de-dupe.
    data.allowedMarketplaces = [...new Set(
      (allowedMarketplaces as string[]).filter((m) => MARKETPLACE_IDS.includes(m)),
    )];
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const user = await prisma.user.update({
    where: { id },
    data,
    select: { id: true, name: true, email: true, role: true, allowedMarketplaces: true, createdAt: true },
  });

  return NextResponse.json(user);
}
