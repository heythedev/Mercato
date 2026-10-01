import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { flags } from "@/lib/flags";
import { parseScopes, redirectUriAllowed, resourceMatches } from "@/lib/oauth/core";
import { canonicalResource, getClient, issueCode } from "@/lib/oauth/store";
import { baseUrl } from "@/lib/oauth/metadata";

export const dynamic = "force-dynamic";

/**
 * What the Allow button posts to.
 *
 * Every parameter is re-checked here rather than trusted from the form. The
 * consent page validated them to decide what to SHOW; this decides what to
 * ISSUE, and a hidden input is just a string the browser sent — a tampered
 * redirect_uri or an escalated scope would otherwise sail through on the
 * strength of a check that happened on a different request.
 */
export async function POST(req: NextRequest) {
  if (!flags.mcp()) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const form = await req.formData();
  const get = (k: string) => String(form.get(k) ?? "");
  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const state = get("state");
  const challenge = get("code_challenge");
  const resource = get("resource");
  const scopes = parseScopes(get("scope"));

  const client = await getClient(clientId);
  if (!client || !redirectUriAllowed(redirectUri, client.redirectUris)) {
    // Same rule as the page: an unverified callback is never sent anything,
    // not even a refusal.
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const out = new URL(redirectUri);
  if (state) out.searchParams.set("state", state);

  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) {
    out.searchParams.set("error", "access_denied");
    out.searchParams.set("error_description", "Not signed in");
    return NextResponse.redirect(out, { status: 303 });
  }

  if (get("decision") !== "allow") {
    out.searchParams.set("error", "access_denied");
    out.searchParams.set("error_description", "The request was declined");
    return NextResponse.redirect(out, { status: 303 });
  }

  if (!challenge) {
    out.searchParams.set("error", "invalid_request");
    out.searchParams.set("error_description", "code_challenge is required");
    return NextResponse.redirect(out, { status: 303 });
  }
  if (!resourceMatches(resource || null, canonicalResource(await baseUrl()))) {
    out.searchParams.set("error", "invalid_target");
    return NextResponse.redirect(out, { status: 303 });
  }

  const code = await issueCode({
    clientId,
    userId,
    redirectUri,
    scopes,
    codeChallenge: challenge,
    resource: resource || null,
  });
  out.searchParams.set("code", code);
  // 303 so the browser follows with GET; a 307 would re-POST to the client.
  return NextResponse.redirect(out, { status: 303 });
}
