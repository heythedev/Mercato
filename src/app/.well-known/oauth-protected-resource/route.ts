import { NextResponse } from "next/server";
import { flags } from "@/lib/flags";
import { METADATA_HEADERS, baseUrl, protectedResourceMetadata } from "@/lib/oauth/metadata";

export const dynamic = "force-dynamic";

/**
 * RFC 9728. How a client learns that /api/mcp is protected and by whom.
 *
 * This is the first thing fetched in the whole flow: the MCP endpoint
 * answers 401 with a WWW-Authenticate pointing here, and everything else is
 * discovered from what this returns. If it 404s, or redirects to a login
 * page, a client reports only that it could not connect.
 */
export async function GET() {
  if (!flags.mcp()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(protectedResourceMetadata(await baseUrl()), { headers: METADATA_HEADERS });
}
