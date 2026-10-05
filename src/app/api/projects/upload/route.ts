import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { flags } from "@/lib/flags";
import { hashSecret } from "@/lib/oauth/core";
import { invokeAsUser } from "@/lib/mcp/invoke";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Upload a vendor file against a one-time ticket, and let Mercato create the
 * project from it exactly as the browser would.
 *
 * This exists because a spreadsheet cannot travel through an MCP tool call —
 * the argument is JSON the model writes, so the file would have to be emitted
 * as base64 character by character, and an .xlsx is a zip where one wrong
 * character corrupts the archive. The bytes have to go from the machine that
 * holds them straight to Mercato, never through the model.
 *
 * Authenticated by the ticket rather than a session, because whoever runs the
 * upload may have no browser session at all — that is the entire point. The
 * ticket is therefore treated as a credential: single-use, short-lived, and
 * carrying the project's name and marketplace itself so a leaked one cannot
 * be redirected into putting arbitrary data somewhere else.
 */
export async function POST(req: NextRequest) {
  if (!flags.mcp()) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const raw = req.nextUrl.searchParams.get("t") ?? "";
  if (!raw) return NextResponse.json({ error: "Missing upload ticket" }, { status: 401 });

  const tokenHash = hashSecret(raw);
  const ticket = await prisma.uploadTicket.findUnique({ where: { tokenHash } });
  // One message for every failure. Telling a caller whether a ticket is
  // unknown, spent or merely expired is an oracle and helps nobody holding a
  // legitimate one.
  const dead = !ticket || ticket.usedAt || ticket.expiresAt.getTime() <= Date.now();
  if (dead) {
    return NextResponse.json({ error: "This upload link is not valid any more. Ask for a new one." }, { status: 401 });
  }

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "Send the spreadsheet as multipart form-data under the field name 'file'." },
      { status: 400 },
    );
  }

  // Claimed by a conditional update so two simultaneous uploads cannot both
  // win and create the project twice — the database decides, not a read.
  const claimed = await prisma.uploadTicket.updateMany({
    where: { tokenHash, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (claimed.count === 0) {
    return NextResponse.json({ error: "This upload link is not valid any more. Ask for a new one." }, { status: 401 });
  }

  // Name and marketplace come from the TICKET, never from the uploader, so
  // the link can only do the one thing it was issued for.
  const forward = new FormData();
  forward.set("file", file, file.name);
  forward.set("name", ticket!.name);
  forward.set("marketplace", ticket!.marketplace);
  if (ticket!.isNewListing) forward.set("isNewListing", "true");

  // Mercato's own creation route: the same parse, the same marketplace
  // check, the same everything the button does.
  const res = await invokeAsUser(ticket!.userId, "/api/projects", { method: "POST", formData: forward });
  if (!res.ok) {
    // Hand the ticket back — the upload failed for a reason the caller may be
    // able to fix, and burning it would make them ask for another.
    await prisma.uploadTicket.updateMany({ where: { tokenHash }, data: { usedAt: null } }).catch(() => {});
  }
  return NextResponse.json(res.body, { status: res.status });
}
