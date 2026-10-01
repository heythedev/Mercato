import { NextResponse } from "next/server";
import { flags } from "@/lib/flags";
import { METADATA_HEADERS, authorizationServerMetadata, baseUrl } from "@/lib/oauth/metadata";

export const dynamic = "force-dynamic";

/** RFC 8414. The endpoints, and which of them a client may use how. */
export async function GET() {
  if (!flags.mcp()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(authorizationServerMetadata(await baseUrl()), { headers: METADATA_HEADERS });
}
