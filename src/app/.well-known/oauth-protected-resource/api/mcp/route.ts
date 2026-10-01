import { NextResponse } from "next/server";
import { flags } from "@/lib/flags";
import { METADATA_HEADERS, baseUrl, protectedResourceMetadata } from "@/lib/oauth/metadata";

export const dynamic = "force-dynamic";

/**
 * The same document, at the path-inserted location.
 *
 * RFC 9728 says a resource at https://host/api/mcp advertises its metadata at
 * https://host/.well-known/oauth-protected-resource/api/mcp — the resource's
 * path is INSERTED after the well-known segment. Clients differ on which they
 * try, and some try only one, so both are served rather than betting on which
 * the next client implements. Serving both costs a file; getting it wrong
 * costs a connection that fails with nothing to show the user.
 */
export async function GET() {
  if (!flags.mcp()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(protectedResourceMetadata(await baseUrl()), { headers: METADATA_HEADERS });
}
