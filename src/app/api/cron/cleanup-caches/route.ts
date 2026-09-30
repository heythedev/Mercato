import { NextResponse } from "next/server";
import { cleanupCaches, DEFAULT_RETENTION, type RetentionPolicy } from "@/lib/maintenance/cleanup";
import { flags } from "@/lib/flags";

// Scheduled cache cleanup. Meant to be hit by a scheduler, NOT by end users —
// so it's gated by a shared secret rather than a user session. Set CRON_SECRET
// in the environment and have the cron send it as
// `Authorization: Bearer <CRON_SECRET>`. Vercel sends exactly that header for
// the schedule declared in vercel.json when CRON_SECRET is set, so the two
// need no further wiring.
//
//   GET/POST /api/cron/cleanup-caches
//
// Overrides (POST body) let you tune retention without redeploying, e.g.
//   { "keepaProductDays": 14 }
//   { "maxDeletesPerRule": 20000 }   ← draining a backlog faster, deliberately
//
// Turning it off: CACHE_CLEANUP_ENABLED=false makes every call a no-op while
// the schedule keeps firing; unsetting CRON_SECRET refuses the call outright.
// Either works, and neither needs the schedule removed from vercel.json.

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // Fail closed: with no secret configured, refuse rather than run unprotected.
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function run(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Answers 200 and does nothing, rather than erroring. A scheduler that
  // reports a failure every night for a feature deliberately switched off is
  // a scheduler everyone learns to ignore.
  if (!flags.cacheCleanup()) {
    return NextResponse.json({ ok: true, skipped: "CACHE_CLEANUP_ENABLED=false" });
  }

  let overrides: Partial<RetentionPolicy> = {};
  if (req.method === "POST") {
    overrides = (await req.json().catch(() => ({}))) as Partial<RetentionPolicy>;
  }

  const result = await cleanupCaches({ ...DEFAULT_RETENTION, ...overrides });
  const total = Object.values(result.deleted).reduce((a, b) => a + b, 0);
  // `capped` says the run stopped at its ceiling with rows still expired, so a
  // backlog reads as "draining" in the log rather than as a finished job that
  // somehow keeps finding thousands of rows every night.
  console.log(
    `[cron/cleanup-caches] deleted ${total} rows` +
      (result.capped.length ? ` — still draining: ${result.capped.join(", ")}` : ""),
    result.deleted,
  );

  return NextResponse.json({ ok: true, totalDeleted: total, ...result });
}

export const GET = run;
export const POST = run;
