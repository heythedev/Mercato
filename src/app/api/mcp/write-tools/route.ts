import { NextRequest, NextResponse } from "next/server";
import { authGuard } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { ALL_WRITE_TOOLS, WRITE_TOOLS, resolveWriteChoice } from "@/lib/mcp/write-tools";

/**
 * Which write tools your own Claude may use.
 *
 * Like the token routes, every handler acts on the signed-in user and takes no
 * parameter for whose choice to change, so there is no way to switch tools on
 * for somebody else.
 */

export async function GET() {
  const { user, response } = await authGuard();
  if (response) return response;
  const row = await prisma.user.findUnique({ where: { id: user!.id }, select: { mcpWriteTools: true } });
  // Expanded, so the page ticks boxes rather than having to know what the
  // sentinel means.
  return NextResponse.json({ tools: resolveWriteChoice(row?.mcpWriteTools ?? []) });
}

export async function PUT(req: NextRequest) {
  const { user, response } = await authGuard();
  if (response) return response;

  const body = (await req.json().catch(() => ({}))) as { tools?: unknown };
  if (!Array.isArray(body.tools)) {
    return NextResponse.json({ error: "tools must be a list of tool names" }, { status: 400 });
  }

  // Unknown names are dropped rather than stored. Unlike an environment
  // variable, nobody types these: the page sends what it was shown, so a name
  // that matches nothing is stale or forged, and keeping it would only switch
  // on a tool of that name if one were ever added.
  const known = new Set(WRITE_TOOLS.map((t) => t.name));
  const tools = [...new Set(body.tools.map(String))].filter((n) => known.has(n));

  // "All" is a standing answer, not a snapshot of today's list: somebody who
  // ticks every box means every write tool, so a twelfth is covered the day it
  // ships rather than silently off. Any smaller selection is stored as the
  // names themselves, so it can only ever narrow.
  const stored = tools.length === known.size ? [ALL_WRITE_TOOLS] : tools;
  await prisma.user.update({ where: { id: user!.id }, data: { mcpWriteTools: stored } });
  return NextResponse.json({ tools });
}
