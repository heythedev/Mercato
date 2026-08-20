import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Build-identity probe. Render has silently kept an old build live after a
 * push before, and a server-only commit changes nothing detectable in the
 * client bundle — so deploy verification needs the server to say which commit
 * it was built from. Render injects RENDER_GIT_COMMIT at build time; locally
 * it's absent. No auth: a commit SHA identifies a build, it reveals nothing.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    commit: process.env.RENDER_GIT_COMMIT ?? null,
  });
}
