"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronDown,
  Download,
  ExternalLink,
  Info,
  RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatYmd } from "@/lib/format-date";
import { DailyBars, ProportionBar, SERIES_COLOR, toDailySeries } from "./usage-charts";

type Row = {
  calls: number;
  input: number;
  output: number;
  units: number;
  failed?: number;
  estCostUsd: number | null;
};
type Report = {
  days: number;
  /** Set when the recording table has not been created yet — see the API route. */
  setupRequired?: boolean;
  setupCommand?: string;
  /**
   * Exact spend, from the drop in the provider's own balance. Null until two
   * readings exist in the window; the token estimate stands in until then.
   */
  actualSpendUsd?: number | null;
  actualByDay?: Record<string, number>;
  balanceReadings?: number;
  /** True when the figures cover one team rather than the whole account. */
  teamScoped?: boolean;
  byDay: (Row & { day: string; service: string })[];
  byService: (Row & { service: string })[];
  byFeature: (Row & { service: string; feature: string })[];
  byProject: (Row & { projectId: string | null; name: string | null })[];
  byModel: (Row & { model: string })[];
};

/** What each provider says it has left right now, for the "can we still work?"
 *  line on each card. Separate from the report: that is history, this is now. */
type Balances = {
  kimi?: { configured: boolean; availableBalance: number | null };
  keepa?: { configured: boolean; tokensLeft?: number; refillRate?: number };
  synccentric?: { configured: boolean; remaining: number | null; limit: number | null };
};

const RANGES = [7, 30, 90] as const;
const SERVICES = ["kimi", "keepa", "synccentric"] as const;

const fmt = (n: number) => n.toLocaleString();
const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
/** Tokens read better in millions once a sweep has run. */
const tok = (n: number) => (n === 0 ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : fmt(n));
const unit = (n: number) => (n === 0 ? "—" : fmt(n));
/** Axis ticks have no room for thousands separators. */
const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));

const SERVICE_LABELS: Record<string, string> = {
  kimi: "Kimi (AI)",
  keepa: "Keepa",
  synccentric: "Synccentric",
};

/** One line saying what an admin is actually paying for. This page is often the
 *  first thing a new admin opens, and the provider names mean nothing alone. */
const SERVICE_BLURBS: Record<string, string> = {
  kimi: "The AI model behind categorisation, verification and export fills",
  keepa: "Amazon catalogue data — prices, images, attributes",
  synccentric: "Product lookup by UPC/ASIN for Amazon verification",
};

/** What each service's `units` column counts — the two are not interchangeable. */
const UNIT_LABELS: Record<string, string> = {
  keepa: "tokens",
  synccentric: "searches",
};

/** Human labels for the feature slugs written by src/lib/ai/usage-context.ts. */
const FEATURE_LABELS: Record<string, string> = {
  categorize: "Categorization",
  spec_product_type: "Walmart product type",
  verify_image: "Image verification",
  verify_title: "Title verification",
  export_dropdown: "Export — dropdown fill",
  export_mandatory: "Export — mandatory cells",
  generate_title: "Title generation",
  template_detect: "Template detection",
  compare_images: "Image compare (ad-hoc)",
  unknown: "Unattributed",
  products_search: "Product search",
  product: "Product lookup",
  search: "Keyword search",
  query: "Query",
  token: "Balance check",
};

/** Column hints. Every header on this page is jargon to someone seeing it for
 *  the first time, and a tooltip costs nothing. */
const HINTS: Record<string, string> = {
  Calls: "Requests sent to the provider, successful or not",
  Sent: "Tokens we sent to the model — prompts, product data, images",
  Back: "Tokens the model returned — usually far fewer, and priced higher",
  Units: "Keepa tokens or Synccentric searches consumed",
  Failed: "Calls that errored. Still billed; their token counts are unknown",
  Cost: "US dollars. Only the AI provider bills per call — the others are quota plans",
  "Est. cost": "Estimated from tokens at the configured rate. The balance knows the total spend but not which project caused it, so a per-row figure can only be an estimate",
};

type Tab = "feature" | "project" | "model" | "day";
const TABS: { id: Tab; label: string }[] = [
  { id: "feature", label: "By feature" },
  { id: "project", label: "By project" },
  { id: "model", label: "By model" },
  { id: "day", label: "By day" },
];

export function AdminUsageClient() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<Report | null>(null);
  const [balances, setBalances] = useState<Balances>({});
  /** False until the balance probes have settled — a provider that could not be
   *  reached must not look the same as one still being asked. */
  const [balancesLoaded, setBalancesLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("feature");
  const [showMethod, setShowMethod] = useState(false);
  /** Bumped by the refresh button to re-run the fetch without changing `days`. */
  const [reloadKey, setReloadKey] = useState(0);

  // The effect never sets state synchronously — only once the fetch settles, and
  // only if this effect instance is still the current one. Range and refresh
  // clicks set the spinner from their own handlers.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/usage?days=${days}`);
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        setData(json);
        setError("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load usage");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days, reloadKey]);

  // Live balances are a second, independent load: three providers that can each
  // be slow or down, and none of them may blank the report when they are.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [km, kp, sc] = await Promise.allSettled([
        fetch("/api/kimi/balance", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/keepa/balance", { cache: "no-store" }).then((r) => r.json()),
        fetch("/api/synccentric/balance", { cache: "no-store" }).then((r) => r.json()),
      ]);
      if (cancelled) return;
      setBalances({
        kimi: km.status === "fulfilled" ? km.value : undefined,
        keepa: kp.status === "fulfilled" ? kp.value : undefined,
        synccentric: sc.status === "fulfilled" ? sc.value : undefined,
      });
      setBalancesLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reload = useCallback(() => {
    setLoading(true);
    setBalancesLoaded(false);
    setReloadKey((k) => k + 1);
  }, []);

  const selectRange = useCallback((r: number) => {
    setLoading(true);
    setDays(r);
  }, []);

  const empty = data && data.byService.length === 0;
  const failed = data?.byService.reduce((a, s) => a + (s.failed ?? 0), 0) ?? 0;

  /** The day holding most of the failures, so the warning can point at a likely
   *  cause instead of only stating a total. */
  const worstFailureDay = useMemo(() => {
    if (!data || failed === 0) return null;
    const byDay = new Map<string, number>();
    for (const r of data.byDay) if (r.failed) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.failed);
    const top = [...byDay].sort((a, b) => b[1] - a[1])[0];
    return top ? { day: top[0], count: top[1], share: top[1] / failed } : null;
  }, [data, failed]);

  const callSeries = useMemo(
    () => (data ? toDailySeries(data.byDay, (r) => r.calls, days) : []),
    [data, days],
  );
  const spendSeries = useMemo(() => {
    if (!data) return [];
    // Measured from the balance where readings cover the day, falling back to
    // the token estimate for days they do not.
    const kimiDays = data.byDay.filter((r) => r.service === "kimi");
    return toDailySeries(kimiDays, (r) => data.actualByDay?.[r.day] ?? r.estCostUsd ?? 0, days);
  }, [data, days]);

  const aiDown = balances.kimi?.configured && (balances.kimi.availableBalance ?? 1) <= 0;

  return (
    <div className="space-y-5">
      {/* Controls in one row, above everything they affect. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex overflow-hidden rounded-lg border">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => selectRange(r)}
              className={cn(
                "px-3 py-1.5 text-sm transition-colors",
                days === r ? "bg-foreground text-background" : "hover:bg-muted",
              )}
            >
              Last {r} days
            </button>
          ))}
        </div>

        <button
          onClick={reload}
          className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm hover:bg-muted"
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          Refresh
        </button>

        {/* Plain link, not fetch+blob: the CSV is a normal authenticated GET and
            the browser's own download handling is what an admin expects. */}
        <a
          href={`/api/admin/usage?days=${days}&format=csv`}
          className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm hover:bg-muted"
        >
          <Download className="h-4 w-4" />
          Download CSV
        </a>

        <span className="ml-auto text-xs text-muted-foreground">
          {data?.teamScoped ? "Your team only" : "One row per billable call"} · days are IST
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/40 px-4 py-3 text-sm text-red-700 dark:text-red-300 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {data?.setupRequired && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/40 px-4 py-4 text-sm text-amber-900 dark:text-amber-200 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">Usage recording is not set up yet.</p>
          <p className="mt-1">
            The code is deployed, but its table has not been created. This database sits behind a
            connection pooler that Prisma&apos;s migration engine cannot drive, so the table is
            created by a script instead. Run this once, from a machine with the project checked out:
          </p>
          <code className="mt-2 block rounded bg-amber-100 dark:bg-amber-900/50 px-2 py-1 font-mono text-xs dark:bg-amber-900/50">
            {data.setupCommand}
          </code>
        </div>
      )}

      {empty && !data?.setupRequired && (
        <div className="rounded-lg border bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
          No billable calls recorded in this window. Usage is recorded from the moment this feature
          was deployed — spend from before that was never stored and cannot be recovered.
        </div>
      )}

      {/* The one thing an admin must not have to hunt for: AI is off, and why. */}
      {aiDown && (
        <Banner tone="critical" icon={AlertTriangle}>
          <span className="font-medium">Kimi has no credit left, so every AI feature is refusing.</span>{" "}
          Categorisation, verification and export fills will not run until the account is topped up.{" "}
          <a
            href="https://platform.moonshot.ai"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium underline underline-offset-2"
          >
            Top up at platform.moonshot.ai
            <ExternalLink className="h-3 w-3" />
          </a>
        </Banner>
      )}

      {data && !empty && (
        <>
          {/* ── What each service cost, and whether it can still run ─────────── */}
          <div className="grid gap-4 sm:grid-cols-3">
            {SERVICES.filter((s) => data.byService.some((r) => r.service === s)).map((service) => {
              const s = data.byService.find((r) => r.service === service)!;
              const isAi = service === "kimi";
              return (
                <div key={service} className="flex flex-col rounded-xl border bg-card p-4">
                  <div className="flex items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
                      style={{ background: SERIES_COLOR[service] }}
                    />
                    <span className="text-sm font-medium">{SERVICE_LABELS[service] ?? service}</span>
                  </div>
                  {/* Reserved for two lines so the figures below sit on one
                      baseline across all three cards, however the text wraps. */}
                  <p className="mt-1 min-h-[2.25rem] text-xs leading-relaxed text-muted-foreground">
                    {SERVICE_BLURBS[service]}
                  </p>

                  <div className="mt-3 flex items-baseline gap-1.5">
                    <span className="text-2xl font-semibold tabular-nums">
                      {isAi
                        ? usd(data.actualSpendUsd != null ? data.actualSpendUsd : s.estCostUsd)
                        : fmt(s.units)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {isAi ? "spent" : `${UNIT_LABELS[service] ?? "units"} used`}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {fmt(s.calls)} calls over {days} days
                    {isAi && (
                      <>
                        {" · "}
                        {data.actualSpendUsd != null ? "measured from balance" : "estimated from tokens"}
                      </>
                    )}
                  </div>

                  <div className="mt-3 border-t pt-2.5 sm:mt-auto">
                    <BalanceLine service={service} balances={balances} loaded={balancesLoaded} />
                  </div>
                </div>
              );
            })}
          </div>

          {failed > 0 && (
            <Banner tone="warning" icon={AlertTriangle}>
              <span className="font-medium">{fmt(failed)} calls failed in this window.</span> Failed
              calls are still billed and their token counts are unknown, so every figure here is a
              floor, not a ceiling.
              {worstFailureDay && worstFailureDay.share > 0.4 && (
                <>
                  {" "}
                  {Math.round(worstFailureDay.share * 100)}% of them ({fmt(worstFailureDay.count)})
                  fell on one day, {formatYmd(worstFailureDay.day)} — worth
                  checking what ran then.
                </>
              )}
            </Banner>
          )}

          {/* ── Trend. Two charts rather than one with two axes: calls and
                 dollars are different units and sharing a scale would make both
                 unreadable. ──────────────────────────────────────────────────── */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel
              title="Calls per day"
              subtitle="Every request sent to a paid provider, stacked by service"
            >
              <DailyBars
                rows={callSeries}
                series={[...SERVICES]}
                labels={SERVICE_LABELS}
                format={compact}
                detail={(r) => [{ label: "Total calls", value: fmt(r.total) }]}
              />
            </Panel>

            <Panel
              title="AI spend per day"
              subtitle={
                data.actualSpendUsd != null
                  ? "The drop in the Kimi account balance, day by day"
                  : "Estimated from tokens until two balance readings exist"
              }
            >
              <DailyBars
                rows={spendSeries}
                series={["kimi"]}
                labels={SERVICE_LABELS}
                format={(n) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)}
                emptyNote="No AI spend recorded in this window."
              />
            </Panel>
          </div>

          {/* ── Breakdowns, one at a time. Four stacked tables of the same shape
                 is what made this page unreadable. ───────────────────────────── */}
          <div className="overflow-hidden rounded-xl border bg-card">
            <div className="flex flex-wrap items-center gap-1 border-b bg-muted/30 px-2 py-2">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    tab === t.id
                      ? "bg-background font-medium shadow-sm"
                      : "text-muted-foreground hover:bg-background/60",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "feature" && <FeatureTable data={data} />}
            {tab === "project" && <ProjectTable data={data} />}
            {tab === "model" && <ModelTable data={data} />}
            {tab === "day" && <DayTable data={data} />}
          </div>

          {/* ── Methodology, folded away. It matters, but not before the numbers. */}
          <div className="rounded-xl border bg-card">
            <button
              onClick={() => setShowMethod((v) => !v)}
              className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium hover:bg-muted/40"
            >
              <Info className="h-4 w-4 text-muted-foreground" />
              How these numbers are measured
              <ChevronDown
                className={cn(
                  "ml-auto h-4 w-4 text-muted-foreground transition-transform",
                  showMethod && "rotate-180",
                )}
              />
            </button>
            {showMethod && (
              <div className="space-y-3 border-t px-4 py-4 text-sm leading-relaxed text-muted-foreground">
                <p>
                  <strong className="text-foreground">Nothing here is inferred.</strong> Token counts
                  come from Kimi&apos;s own responses, Keepa tokens from the{" "}
                  <code className="rounded bg-muted px-1">tokensConsumed</code> field it returns on
                  every call, and Synccentric searches from its quota headers. One row is written per
                  billable call, attributed to the feature and project that caused it.
                </p>
                <p>
                  {data.actualSpendUsd != null ? (
                    <>
                      <strong className="text-foreground">
                        Kimi&apos;s cost is the actual drop in the account balance
                      </strong>{" "}
                      across {data.balanceReadings} readings in this window — the provider&apos;s own
                      arithmetic, so no price list is involved and cached tokens are already
                      accounted for. Top-ups are ignored rather than netted off, so a recharge in the
                      middle of the window cannot hide the spend around it.
                    </>
                  ) : (
                    <>
                      <strong className="text-foreground">Kimi&apos;s cost is estimated</strong> from
                      tokens until two balance readings exist in this window. It becomes exact on its
                      own once they do, with no configuration needed.
                    </>
                  )}
                </p>
                <p>
                  Keepa and Synccentric are flat quota plans, not per-call billing, so their spend is
                  shown in units. A dollar figure there would be invented.
                </p>
                {data.teamScoped && (
                  <p>
                    <strong className="text-foreground">These figures cover your team only</strong> —
                    calls made against your team&apos;s projects. Calls that carry no project, such
                    as balance probes and one-off scripts, cannot be attributed to a team and are
                    left out rather than guessed at. The dollar figure is the token estimate: the
                    Kimi balance is one account funding every team, so its drop measures the whole
                    organisation and would attribute everyone&apos;s usage to you.
                  </p>
                )}
                <p>
                  None of the three providers reports usage history — Kimi has no usage endpoint at
                  all, the other two return only a running quota. This page is the only record, and
                  it begins the day recording was deployed.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────────

function Banner({
  tone,
  icon: Icon,
  children,
}: {
  tone: "warning" | "critical";
  icon: typeof AlertTriangle;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm",
        tone === "critical"
          ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/**
 * "What is left right now" for one service, with a state word beside the dot —
 * the colour never carries the meaning on its own.
 */
function BalanceLine({
  service,
  balances,
  loaded,
}: {
  service: string;
  balances: Balances;
  loaded: boolean;
}) {
  let value = "—";
  let state: "good" | "warning" | "critical" | "unknown" = "unknown";
  // Once the probes have settled, a provider with no entry is one we could not
  // reach — saying "Checking…" forever would read as "still working on it".
  let word = loaded ? "Could not reach" : "Checking…";

  if (service === "kimi" && balances.kimi) {
    const b = balances.kimi.availableBalance;
    if (!balances.kimi.configured) {
      value = "not configured";
      word = "Off";
    } else if (b == null) {
      value = "unavailable";
      word = "Unknown";
    } else {
      value = `$${b.toFixed(2)}`;
      state = b <= 0 ? "critical" : b < 5 ? "warning" : "good";
      word = b <= 0 ? "Out of credit" : b < 5 ? "Running low" : "Healthy";
    }
  } else if (service === "keepa" && balances.keepa) {
    const t = balances.keepa.tokensLeft;
    if (t == null) {
      value = "unavailable";
      word = "Unknown";
    } else {
      value = `${fmt(t)} tokens`;
      state = t <= 0 ? "critical" : t < 1000 ? "warning" : "good";
      word =
        t <= 0
          ? "Empty"
          : t < 1000
            ? "Running low"
            : `Healthy${balances.keepa.refillRate ? ` · +${balances.keepa.refillRate}/min` : ""}`;
    }
  } else if (service === "synccentric" && balances.synccentric) {
    const { remaining, limit } = balances.synccentric;
    if (remaining == null) {
      value = "unavailable";
      word = "Unknown";
    } else {
      value = limit ? `${fmt(remaining)} of ${fmt(limit)}` : `${fmt(remaining)} left`;
      const share = limit ? remaining / limit : 1;
      state = remaining <= 0 ? "critical" : share < 0.1 ? "warning" : "good";
      word = remaining <= 0 ? "Exhausted today" : share < 0.1 ? "Nearly used up" : "Healthy";
    }
  }

  const dot =
    state === "good"
      ? "var(--status-good)"
      : state === "warning"
        ? "var(--status-warning)"
        : state === "critical"
          ? "var(--status-critical)"
          : "var(--viz-axis)";

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />
      <span className="text-muted-foreground">Left now</span>
      <span className="ml-auto text-right">
        <span className="font-medium tabular-nums">{value}</span>
        <span className="block text-[10px] text-muted-foreground">{word}</span>
      </span>
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  // No overflow-hidden here, unlike the tabbed panel below: the chart's tooltip
  // is anchored above the bar it describes and would be clipped by the card.
  // Nothing else in this panel paints to the edge, so the rounded corners hold.
  return (
    <div className="rounded-xl border bg-card">
      <div className="border-b px-4 py-3">
        <div className="text-sm font-medium">{title}</div>
        {subtitle && <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

type Cell = { node: ReactNode; align?: "left" | "right" };

/** A cell's alignment: its own, else left for the leading column and right for
 *  the numeric ones. Used for the header too, so the two cannot disagree. */
const align = (c: Cell | undefined, i: number): "left" | "right" =>
  c?.align ?? (i === 0 ? "left" : "right");

function DataTable({ head, rows }: { head: string[]; rows: Cell[][] }) {
  if (rows.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-sm text-muted-foreground">Nothing recorded here.</div>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            {head.map((h, i) => (
              <th
                key={h}
                title={HINTS[h]}
                className={cn(
                  "px-4 py-2.5 font-medium",
                  // The header follows its column's cells, not the column index:
                  // the service tag is left-aligned in an otherwise numeric row.
                  align(rows[0]?.[i], i) === "left" ? "text-left" : "text-right",
                  HINTS[h] && "cursor-help decoration-dotted underline-offset-4 hover:underline",
                )}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri} className="border-b last:border-0 hover:bg-muted/40">
              {r.map((c, ci) => (
                <td
                  key={ci}
                  className={cn(
                    "px-4 py-2.5 align-middle",
                    align(c, ci) === "left" ? "text-left" : "text-right tabular-nums",
                  )}
                >
                  {c.node}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Leading cell: a name with the row's share of the table's largest row beneath
 *  it. The bar is what makes a forty-row table scannable. */
function NameCell({ name, fraction, color }: { name: string; fraction: number; color?: string }) {
  return (
    <div className="min-w-[180px]">
      <span>{name}</span>
      <ProportionBar fraction={fraction} color={color} />
    </div>
  );
}

function ServiceTag({ service }: { service: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="h-2 w-2 rounded-[2px]" style={{ background: SERIES_COLOR[service] }} />
      <span className="text-muted-foreground">{SERVICE_LABELS[service] ?? service}</span>
    </span>
  );
}

function FeatureTable({ data }: { data: Report }) {
  const max = Math.max(...data.byFeature.map((r) => r.calls), 1);
  return (
    <DataTable
      head={["Feature", "Service", "Calls", "Sent", "Back", "Units"]}
      rows={data.byFeature.map((r) => [
        {
          node: (
            <NameCell
              name={FEATURE_LABELS[r.feature] ?? r.feature}
              fraction={r.calls / max}
              color={SERIES_COLOR[r.service]}
            />
          ),
          align: "left" as const,
        },
        { node: <ServiceTag service={r.service} />, align: "left" as const },
        { node: fmt(r.calls) },
        { node: tok(r.input) },
        { node: tok(r.output) },
        { node: unit(r.units) },
      ])}
    />
  );
}

function ProjectTable({ data }: { data: Report }) {
  const max = Math.max(...data.byProject.map((r) => r.calls), 1);
  return (
    <DataTable
      head={["Project", "Calls", "Sent", "Back", "Units", "Est. cost"]}
      rows={data.byProject.map((r) => [
        {
          node: (
            <NameCell
              name={r.name ?? (r.projectId ? r.projectId.slice(0, 8) : "— no project —")}
              fraction={r.calls / max}
            />
          ),
          align: "left" as const,
        },
        { node: fmt(r.calls) },
        { node: tok(r.input) },
        { node: tok(r.output) },
        { node: unit(r.units) },
        { node: usd(r.estCostUsd) },
      ])}
    />
  );
}

function ModelTable({ data }: { data: Report }) {
  const max = Math.max(...data.byModel.map((r) => r.calls), 1);
  return (
    <DataTable
      head={["Model", "Calls", "Sent", "Back", "Est. cost"]}
      rows={data.byModel.map((r) => [
        { node: <NameCell name={r.model} fraction={r.calls / max} />, align: "left" as const },
        { node: fmt(r.calls) },
        { node: tok(r.input) },
        { node: tok(r.output) },
        { node: usd(r.estCostUsd) },
      ])}
    />
  );
}

function DayTable({ data }: { data: Report }) {
  return (
    <DataTable
      head={["Day", "Service", "Calls", "Sent", "Back", "Units", "Failed", "Cost"]}
      rows={data.byDay.map((r) => [
        { node: formatYmd(r.day), align: "left" as const },
        { node: <ServiceTag service={r.service} />, align: "left" as const },
        { node: fmt(r.calls) },
        { node: tok(r.input) },
        { node: tok(r.output) },
        { node: unit(r.units) },
        {
          node: r.failed ? (
            <span className="font-medium" style={{ color: "var(--status-critical)" }}>
              {fmt(r.failed)}
            </span>
          ) : (
            "—"
          ),
        },
        {
          // Measured from the balance where readings cover that day; the token
          // estimate only as a fallback.
          node:
            r.service === "kimi" && data.actualByDay?.[r.day] != null
              ? usd(data.actualByDay[r.day])
              : usd(r.estCostUsd),
        },
      ])}
    />
  );
}
