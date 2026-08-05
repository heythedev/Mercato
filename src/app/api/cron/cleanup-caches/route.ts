import { NextResponse } from "next/server";
import { cleanupCaches, DEFAULT_RETENTION, type RetentionPolicy } from "@/lib/maintenance/cleanup";

// Scheduled cache cleanup. Meant to be hit by a Render Cron Job (or any
// scheduler), NOT by end users — so it's gated by a shared secret rather than a
// user session. Set CRON_SECRET in the environment and have the cron send it as
// `Authorization: Bearer <CRON_SECRET>`.
//
//   GET/POST /api/cron/cleanup-caches
//
// Overrides (POST body) let you tune retention without redeploying, e.g.
//   { "keepaProductDays": 14 }

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

  let overrides: Partial<RetentionPolicy> = {};
  if (req.method === "POST") {
    overrides = (await req.json().catch(() => ({}))) as Partial<RetentionPolicy>;
  }

  const result = await cleanupCaches({ ...DEFAULT_RETENTION, ...overrides });
  const total = Object.values(result.deleted).reduce((a, b) => a + b, 0);
  console.log(`[cron/cleanup-caches] deleted ${total} rows`, result.deleted);

  return NextResponse.json({ ok: true, totalDeleted: total, ...result });
}

export const GET = run;
export const POST = run;
