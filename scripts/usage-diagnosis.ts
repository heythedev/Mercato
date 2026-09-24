/**
 * Where the AI money actually goes, and how much of it bought nothing.
 *
 * Read-only. Answers three questions the usage screen only hints at: which
 * calls failed and why, which features cost the most per unit of work, and
 * whether the same work is being paid for more than once.
 *
 *   pnpm exec tsx scripts/usage-diagnosis.ts [days]
 */
import "dotenv/config";
import { prisma } from "../src/lib/db";

const DAYS = Number(process.argv[2] ?? 30);
const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
const n = (v: bigint | number | null) => Number(v ?? 0);
const pad = (s: string | number, w: number) => String(s).padStart(w);

(async () => {
  console.log(`\n=== Last ${DAYS} days ===\n`);

  // ── 1. What failed, when, and how fast ──────────────────────────────────
  const fails = await prisma.$queryRaw<
    { service: string; feature: string; day: string; calls: bigint; avgms: number | null }[]
  >`
    select service, feature,
           to_char("createdAt" at time zone 'Asia/Kolkata', 'DD Mon') as day,
           count(*) as calls, avg("durationMs")::int as avgms
    from "ServiceUsage"
    where "createdAt" >= ${since} and not ok
    group by 1,2,3 order by count(*) desc limit 12`;

  console.log("FAILED CALLS — biggest groups");
  console.log("  calls   avg ms  service      feature                day");
  for (const f of fails) {
    console.log(
      `  ${pad(n(f.calls), 5)}  ${pad(f.avgms ?? "—", 7)}  ${f.service.padEnd(12)} ${f.feature.padEnd(22)} ${f.day}`,
    );
  }

  // ── 2. Cost per unit of work ────────────────────────────────────────────
  const byFeature = await prisma.$queryRaw<
    { feature: string; calls: bigint; input: bigint; output: bigint; failed: bigint }[]
  >`
    select feature, count(*) as calls, sum("inputTokens") as input,
           sum("outputTokens") as output, count(*) filter (where not ok) as failed
    from "ServiceUsage"
    where "createdAt" >= ${since} and service = 'kimi'
    group by 1 order by sum("inputTokens") desc`;

  const totalIn = byFeature.reduce((a, f) => a + n(f.input), 0) || 1;
  console.log("\nAI FEATURES — where the tokens go");
  console.log("  share   calls    in/call  out/call  failed  feature");
  for (const f of byFeature) {
    const calls = n(f.calls) || 1;
    console.log(
      `  ${pad((n(f.input) / totalIn * 100).toFixed(0) + "%", 5)}  ${pad(n(f.calls), 6)}  ` +
        `${pad(Math.round(n(f.input) / calls), 8)}  ${pad(Math.round(n(f.output) / calls), 8)}  ` +
        `${pad(n(f.failed), 6)}  ${f.feature}`,
    );
  }

  // ── 3. Is the same work being paid for twice? ───────────────────────────
  // One image-verification call is meant to settle one product. Many more
  // calls than products means the same products are being re-checked.
  const reruns = await prisma.$queryRaw<
    { name: string | null; products: bigint; calls: bigint }[]
  >`
    select p.name,
           (select count(*) from "Product" pr where pr."projectId" = p.id) as products,
           count(*) as calls
    from "ServiceUsage" u join "Project" p on p.id = u."projectId"
    where u."createdAt" >= ${since} and u.service = 'kimi' and u.feature = 'verify_image'
    group by p.id, p.name
    having count(*) > 50
    order by count(*) desc limit 10`;

  console.log("\nIMAGE VERIFICATION — calls vs products in the project");
  console.log("  calls  products  per product  project");
  for (const r of reruns) {
    const prod = n(r.products) || 1;
    console.log(
      `  ${pad(n(r.calls), 5)}  ${pad(n(r.products), 8)}  ${pad((n(r.calls) / prod).toFixed(1), 11)}  ${(r.name ?? "").slice(0, 34)}`,
    );
  }

  // ── 4. What the failures cost ───────────────────────────────────────────
  const [tot] = await prisma.$queryRaw<{ all: bigint; bad: bigint }[]>`
    select count(*) as all, count(*) filter (where not ok) as bad
    from "ServiceUsage" where "createdAt" >= ${since} and service = 'kimi'`;
  console.log(
    `\nFAILURE RATE (AI): ${n(tot.bad)} of ${n(tot.all)} calls = ` +
      `${((n(tot.bad) / (n(tot.all) || 1)) * 100).toFixed(1)}% — billed, no output returned.`,
  );

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FAILED:", String(e).slice(0, 300));
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
