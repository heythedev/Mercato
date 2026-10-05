import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { flags } from "@/lib/flags";
import { hashSecret } from "@/lib/oauth/core";
import { getJobZip } from "@/lib/export/job-store";
import { buildDownloadName, contentDisposition } from "@/lib/export/filename";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Fetch a finished export against a short-lived ticket.
 *
 * The mirror of the upload route, and it exists for the same reason: a tool
 * call returns text the model relays, so a multi-megabyte archive cannot come
 * back that way. The link goes through the conversation; the bytes do not.
 *
 * Authenticated by the ticket rather than a session, because whoever follows
 * the link may have none — that is the point. Authorisation happened when the
 * ticket was issued, against the person who asked for it; nothing here can
 * widen that, since a ticket names ONE job.
 */
export async function GET(req: NextRequest) {
  if (!flags.mcp()) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const raw = req.nextUrl.searchParams.get("t") ?? "";
  if (!raw) return NextResponse.json({ error: "Missing download ticket" }, { status: 401 });

  const tokenHash = hashSecret(raw);
  const ticket = await prisma.downloadTicket.findUnique({ where: { tokenHash } });

  // One message for every failure. Telling a caller whether a ticket is
  // unknown, spent or merely expired is an oracle and helps nobody holding a
  // legitimate one.
  const dead =
    !ticket || ticket.expiresAt.getTime() <= Date.now() || ticket.uses >= ticket.maxUses;
  if (dead) {
    return NextResponse.json(
      { error: "This download link is not valid any more. Ask for a new one." },
      { status: 401 },
    );
  }

  // Claimed before the bytes are read, and conditionally, so two clicks at
  // once cannot both slip past the cap.
  const claimed = await prisma.downloadTicket.updateMany({
    where: { tokenHash, uses: { lt: ticket.maxUses }, expiresAt: { gt: new Date() } },
    data: { uses: { increment: 1 } },
  });
  if (claimed.count === 0) {
    return NextResponse.json(
      { error: "This download link is not valid any more. Ask for a new one." },
      { status: 401 },
    );
  }

  const job = await prisma.exportJob.findUnique({
    where: { id: ticket.jobId },
    select: { status: true, extension: true, contentType: true, projectId: true },
  });
  if (!job || job.status !== "done") {
    return NextResponse.json({ error: "That export is no longer available" }, { status: 410 });
  }

  const [zip, meta] = await Promise.all([
    getJobZip(ticket.jobId),
    prisma.project.findUnique({
      where: { id: job.projectId },
      select: { name: true, marketplace: true },
    }),
  ]);
  if (!zip) {
    return NextResponse.json(
      { error: "Export payload missing — please run the export again" },
      { status: 410 },
    );
  }

  const filename = buildDownloadName({
    projectName: meta?.name,
    marketplace: meta?.marketplace,
    extension: job.extension ?? "zip",
  });

  return new Response(zip as unknown as BodyInit, {
    headers: {
      "Content-Type": job.contentType ?? "application/zip",
      "Content-Disposition": contentDisposition(filename),
      // A credential in a URL must not be cached by anything on the way.
      "Cache-Control": "no-store, private",
    },
  });
}
