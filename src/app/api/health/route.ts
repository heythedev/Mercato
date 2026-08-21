import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Build-identity probe. Render has silently kept an old build live after a
 * push before, and a server-only commit changes nothing detectable in the
 * client bundle — so deploy verification needs the server to say which commit
 * it was built from. Render injects RENDER_GIT_COMMIT, Vercel injects
 * VERCEL_GIT_COMMIT_SHA; locally both are absent. No auth: a commit SHA
 * identifies a build, it reveals nothing.
 *
 * dbPooled reports whether DATABASE_URL carries pgbouncer=true — required on
 * Supabase's transaction pooler or Prisma's prepared statements collide and
 * cold instances 500. Boolean only; the URL itself is never exposed.
 */
export async function GET() {
  return NextResponse.json({
    ok: true,
    commit: process.env.RENDER_GIT_COMMIT ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    dbPooled: /[?&]pgbouncer=true/.test(process.env.DATABASE_URL ?? ""),
  });
}
