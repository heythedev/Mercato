import { NextRequest, NextResponse } from "next/server";
import { anyAdminGuard } from "@/lib/auth-helpers";
import { actorOf, isAdmin } from "@/lib/authz";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { flushUsage } from "@/lib/ai/usage-log";
import { estimateCost } from "@/lib/ai/usage-pricing";
import { spentCents, spentByDay } from "@/lib/ai/balance-history";

export const dynamic = "force-dynamic";

/**
 * Admin-only spend report across every paid service: Kimi (AI), Keepa and
 * Synccentric.
 *
 *   GET /api/admin/usage?days=30            → JSON summary (by day, service, feature, project)
 *   GET /api/admin/usage?days=30&format=csv → one row per call, as a download
 *
 * None of the three providers reports history — Kimi has no usage endpoint at
 * all, and the other two return only a running quota — so this table is the only
 * account of where credits went. It stays readable when every balance is at
 * zero, which is exactly when it is needed.
 */
export async function GET(req: NextRequest) {
  const { user, response } = await anyAdminGuard();
  if (response) return response;
  const actor = actorOf(user);

  // ServiceUsage records the project a call was made for, not the team, so a
  // team's spend is "every call against a project this team owns". Rows with no
  // project — a balance probe, a one-off script — cannot be attributed to a
  // team and are therefore left out of a team admin's figures rather than
  // guessed at.
  const teamOnly = !isAdmin(actor);
  const scope = (alias: string) =>
    teamOnly
      ? Prisma.sql` and ${Prisma.raw(alias)}"projectId" in (select id from "Project" where "teamId" = ${actor.teamId})`
      : Prisma.empty;

  // Rows buffered by this instance would otherwise be missing from a report run
  // moments after a job finished.
  await flushUsage();

  const params = req.nextUrl.searchParams;
  const days = Math.min(Math.max(Number(params.get("days") ?? 30), 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const format = params.get("format");

  // The table is created by scripts/apply-pending-tables.ts, not by
  // `prisma migrate deploy` — this database sits behind a transaction pooler the
  // migration engine cannot drive. So a deploy can legitimately land before the
  // table exists, and when it did, this route answered a bare HTTP 500 that told
  // the admin nothing. Report the real state instead, with the command that
  // fixes it, for both the report and the download.
  const [{ n: tableCount }] = await prisma.$queryRaw<{ n: bigint }[]>`
    select count(*) as n from information_schema.tables where table_name = 'ServiceUsage'`;
  if (Number(tableCount) === 0) {
    const setupCommand = "pnpm exec tsx scripts/apply-pending-tables.ts";
    if (format === "csv") {
      return new NextResponse(`# usage recording is not set up yet — run: ${setupCommand}\n`, {
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      });
    }
    return NextResponse.json({
      days,
      since: since.toISOString(),
      setupRequired: true,
      setupCommand,
      byDay: [], byService: [], byFeature: [], byProject: [], byModel: [],
    });
  }

  if (format === "csv") {
    const projectIds = teamOnly
      ? (
          await prisma.project.findMany({
            where: { teamId: actor.teamId },
            select: { id: true },
          })
        ).map((p) => p.id)
      : null;
    const rows = await prisma.serviceUsage.findMany({
      where: {
        createdAt: { gte: since },
        ...(projectIds ? { projectId: { in: projectIds } } : {}),
      },
      orderBy: { createdAt: "desc" },
      // A full sweep can be tens of thousands of calls a day; cap the download so
      // an admin cannot accidentally ask the server to materialise a year.
      take: 200_000,
      select: {
        createdAt: true,
        service: true,
        feature: true,
        model: true,
        projectId: true,
        userId: true,
        inputTokens: true,
        outputTokens: true,
        units: true,
        durationMs: true,
        ok: true,
      },
    });

    const header =
      "timestamp,service,feature,model,project_id,user_id,input_tokens,output_tokens,units,duration_ms,ok,est_cost_usd";
    const body = rows
      .map((r) =>
        [
          r.createdAt.toISOString(),
          r.service,
          r.feature,
          r.model ?? "",
          r.projectId ?? "",
          r.userId ?? "",
          r.inputTokens,
          r.outputTokens,
          r.units,
          r.durationMs ?? "",
          r.ok ? "yes" : "no",
          // Only the AI provider bills per token; Keepa and Synccentric are
          // quota plans, so a dollar figure there would be invented.
          r.service === "kimi" ? estimateCost(r.model ?? "", r.inputTokens, r.outputTokens).toFixed(6) : "",
        ].join(","),
      )
      .join("\n");

    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(`${header}\n${body}\n`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="mercato-usage-${stamp}.csv"`,
      },
    });
  }

  const [byDay, byService, byFeature, byProject, byModel] = await Promise.all([
    prisma.$queryRaw<
      { day: string; service: string; calls: bigint; input: bigint; output: bigint; units: bigint; failed: bigint }[]
    >`
      select to_char("createdAt" at time zone 'Asia/Kolkata', 'YYYY-MM-DD') as day, service,
             count(*) as calls, sum("inputTokens") as input, sum("outputTokens") as output,
             sum(units) as units, count(*) filter (where not ok) as failed
      from "ServiceUsage" where "createdAt" >= ${since}${scope("")}
      group by 1, 2 order by 1 desc, 2`,
    prisma.$queryRaw<
      { service: string; calls: bigint; input: bigint; output: bigint; units: bigint; failed: bigint }[]
    >`
      select service, count(*) as calls, sum("inputTokens") as input, sum("outputTokens") as output,
             sum(units) as units, count(*) filter (where not ok) as failed
      from "ServiceUsage" where "createdAt" >= ${since}${scope("")}
      group by 1 order by count(*) desc`,
    prisma.$queryRaw<
      { service: string; feature: string; calls: bigint; input: bigint; output: bigint; units: bigint }[]
    >`
      select service, feature, count(*) as calls, sum("inputTokens") as input,
             sum("outputTokens") as output, sum(units) as units
      from "ServiceUsage" where "createdAt" >= ${since}${scope("")}
      group by 1, 2 order by count(*) desc limit 40`,
    prisma.$queryRaw<
      { projectId: string | null; name: string | null; calls: bigint; input: bigint; output: bigint; units: bigint }[]
    >`
      select u."projectId", p.name, count(*) as calls, sum(u."inputTokens") as input,
             sum(u."outputTokens") as output, sum(u.units) as units
      from "ServiceUsage" u left join "Project" p on p.id = u."projectId"
      where u."createdAt" >= ${since}${scope("u.")}
      group by 1, 2 order by count(*) desc limit 25`,
    prisma.$queryRaw<{ model: string; calls: bigint; input: bigint; output: bigint }[]>`
      select model, count(*) as calls, sum("inputTokens") as input, sum("outputTokens") as output
      from "ServiceUsage" where "createdAt" >= ${since} and model is not null${scope("")}
      group by 1 order by count(*) desc`,
  ]);

  // Failures that never left the app. When the AI balance empties, the provider
  // fetch short-circuits on the recorded outage and throws BEFORE any request is
  // made — so those calls cost nothing. They dominate the failure count (969 of
  // 993 over one 30-day window), and reporting them as billed overstates the
  // waste by two orders of magnitude. The split is by duration because that is
  // what distinguishes them: a local throw takes single-digit milliseconds, a
  // real round trip does not.
  const [{ n: notSent }] = await prisma.$queryRaw<{ n: bigint }[]>`
    select count(*) as n from "ServiceUsage"
    where "createdAt" >= ${since} and not ok and "durationMs" < 100${scope("")}`;

  // Spend measured from the provider's own balance: exact, and independent of
  // any configured rate. Token totals times a price can only estimate, because
  // cached input tokens bill differently and no total says which were cached.
  const snapshots = await prisma.balanceSnapshot
    .findMany({
      where: { service: "kimi", capturedAt: { gte: since } },
      select: { balanceCents: true, capturedAt: true },
      orderBy: { capturedAt: "asc" },
    })
    .catch(() => [] as { balanceCents: number; capturedAt: Date }[]);
  // The Kimi balance is ONE account funding every team, so its drop measures
  // the whole organisation's spend, not this team's. Showing it to a team admin
  // would attribute everyone's usage to them. They get the token estimate,
  // which is scoped to their rows and honestly labelled as an estimate.
  const actualSpendUsd = teamOnly ? 0 : spentCents(snapshots) / 100;
  const actualByDay = teamOnly
    ? {}
    : Object.fromEntries([...spentByDay(snapshots)].map(([day, cents]) => [day, cents / 100]));

  // BigInt does not survive JSON.stringify.
  const n = (v: bigint | null | undefined) => Number(v ?? 0);
  const cost = (service: string, model: string | null, input: number, output: number) =>
    service === "kimi" ? estimateCost(model ?? "", input, output) : null;

  const shape = <T extends { service?: string; model?: string | null }>(r: T & {
    calls: bigint;
    input: bigint;
    output: bigint;
    units?: bigint;
    failed?: bigint;
  }) => {
    const input = n(r.input);
    const output = n(r.output);
    return {
      ...r,
      calls: n(r.calls),
      input,
      output,
      units: n(r.units),
      failed: n(r.failed),
      estCostUsd: cost(r.service ?? "kimi", r.model ?? null, input, output),
    };
  };

  return NextResponse.json({
    days,
    since: since.toISOString(),
    /** Exact, from the balance itself. Null when too few readings exist yet. */
    actualSpendUsd: !teamOnly && snapshots.length >= 2 ? actualSpendUsd : null,
    actualByDay,
    balanceReadings: teamOnly ? 0 : snapshots.length,
    /** Of the failures, how many were refused locally and cost nothing. */
    failedNotSent: Number(notSent),
    /** True when these figures cover one team rather than the whole account. */
    teamScoped: teamOnly,
    byDay: byDay.map(shape),
    byService: byService.map(shape),
    byFeature: byFeature.map(shape),
    // Token columns are zero on non-AI rows by construction, so a project's
    // token totals (and therefore its cost) are already the AI part alone.
    byProject: byProject.map((r) => ({
      projectId: r.projectId,
      name: r.name,
      calls: n(r.calls),
      input: n(r.input),
      output: n(r.output),
      units: n(r.units),
      estCostUsd: estimateCost("", n(r.input), n(r.output)),
    })),
    byModel: byModel.map((r) => ({
      model: r.model,
      calls: n(r.calls),
      input: n(r.input),
      output: n(r.output),
      units: 0,
      estCostUsd: estimateCost(r.model, n(r.input), n(r.output)),
    })),
  });
}
