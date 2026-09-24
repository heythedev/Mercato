"use client";

import { useEffect, useMemo, useState } from "react";
import { Printer } from "lucide-react";
import { formatDate, formatDateTime, formatYmd } from "@/lib/format-date";
import { SERIES_COLOR, toDailySeries } from "./usage-charts";

/**
 * The usage report, laid out as a document rather than a screen.
 *
 * The Usage & credits screen answers "what is happening right now"; this
 * answers "what did this cost and why", for someone who was not watching. So
 * it leads with the figures a budget holder asks for, states the conclusions
 * in words rather than leaving them to be inferred from a table, and puts the
 * detail underneath for anyone who wants to check the reasoning.
 *
 * Printing is the delivery mechanism: A4 portrait, colours forced on so the
 * charts survive the browser's ink-saving default, and every block kept whole
 * so a page break never lands mid-table.
 */

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
  since: string;
  setupRequired?: boolean;
  actualSpendUsd?: number | null;
  actualByDay?: Record<string, number>;
  balanceReadings?: number;
  teamScoped?: boolean;
  byDay: (Row & { day: string; service: string })[];
  byService: (Row & { service: string })[];
  byFeature: (Row & { service: string; feature: string })[];
  byProject: (Row & { projectId: string | null; name: string | null })[];
  byModel: (Row & { model: string })[];
};

const SERVICES = ["kimi", "keepa", "synccentric"] as const;
const SERVICE_LABELS: Record<string, string> = {
  kimi: "Kimi (AI)",
  keepa: "Keepa",
  synccentric: "Synccentric",
};
const SERVICE_ROLE: Record<string, string> = {
  kimi: "Categorisation, verification and export fills",
  keepa: "Amazon catalogue data",
  synccentric: "Product lookup by UPC/ASIN",
};
const UNIT_LABELS: Record<string, string> = { keepa: "tokens", synccentric: "searches" };

const FEATURE_LABELS: Record<string, string> = {
  categorize: "Categorisation",
  spec_product_type: "Walmart product type",
  verify_image: "Image verification",
  verify_title: "Title verification",
  export_dropdown: "Export — dropdown fill",
  export_mandatory: "Export — mandatory cells",
  generate_title: "Title generation",
  template_detect: "Template detection",
  compare_images: "Image compare",
  unknown: "Unattributed",
  products_search: "Product search",
  product: "Product lookup",
  search: "Keyword search",
  query: "Query",
  token: "Balance check",
};

const fmt = (n: number) => n.toLocaleString();
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);
const tok = (n: number) => (n === 0 ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : fmt(n));
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function UsageReport({ days }: { days: number }) {
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/usage?days=${days}`, { cache: "no-store" });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not load the report");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days]);

  const kimi = data?.byService.find((s) => s.service === "kimi");
  const totalCalls = data?.byService.reduce((a, s) => a + s.calls, 0) ?? 0;
  const totalFailed = data?.byService.reduce((a, s) => a + (s.failed ?? 0), 0) ?? 0;
  const spend = data?.actualSpendUsd ?? kimi?.estCostUsd ?? 0;
  const measured = data?.actualSpendUsd != null;

  /** AI features only — the two quota services have no per-feature dollar cost. */
  const aiFeatures = useMemo(() => {
    if (!data) return [];
    const ai = data.byFeature.filter((f) => f.service === "kimi");
    const totalTokens = ai.reduce((a, f) => a + f.input + f.output, 0) || 1;
    return ai
      .map((f) => ({
        ...f,
        // Spend is measured for the account as a whole, not per feature. Sharing
        // it out by token volume is the honest approximation, and it is labelled
        // as a share rather than presented as a billed figure.
        share: (f.input + f.output) / totalTokens,
      }))
      .sort((a, b) => b.share - a.share);
  }, [data]);

  const worstDay = useMemo(() => {
    if (!data || totalFailed === 0) return null;
    const byDay = new Map<string, number>();
    for (const r of data.byDay) if (r.failed) byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.failed);
    const top = [...byDay].sort((a, b) => b[1] - a[1])[0];
    return top ? { day: top[0], count: top[1], share: top[1] / totalFailed } : null;
  }, [data, totalFailed]);

  const callSeries = useMemo(
    () => (data ? toDailySeries(data.byDay, (r) => r.calls, data.days) : []),
    [data],
  );
  const spendSeries = useMemo(() => {
    if (!data) return [];
    const k = data.byDay.filter((r) => r.service === "kimi");
    return toDailySeries(k, (r) => data.actualByDay?.[r.day] ?? r.estCostUsd ?? 0, data.days);
  }, [data]);

  const activeDays = callSeries.filter((d) => d.total > 0).length;
  const perActiveDay = activeDays > 0 ? spend / activeDays : 0;

  if (error) {
    return <div className="mx-auto max-w-[190mm] p-10 text-sm text-red-700">{error}</div>;
  }
  if (!data) {
    return <div className="mx-auto max-w-[190mm] p-10 text-sm text-neutral-500">Preparing the report…</div>;
  }

  return (
    <div className="report mx-auto max-w-[190mm] px-8 py-10 print:px-0 print:py-0">
      <PrintStyles />

      {/* Screen-only controls. */}
      <div className="no-print mb-8 flex flex-wrap items-center gap-3 border-b pb-4">
        <button
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-lg bg-neutral-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-neutral-800"
        >
          <Printer className="h-4 w-4" />
          Print / Save as PDF
        </button>
        <span className="text-xs text-neutral-500">
          A4 · choose “Save as PDF” in the print dialog.
        </span>
        {[7, 30, 90].map((d) => (
          <a
            key={d}
            href={`/admin/usage/report?days=${d}`}
            className={`rounded-md border px-2.5 py-1 text-xs ${
              d === data.days ? "border-neutral-900 bg-neutral-900 text-white" : "hover:bg-neutral-100"
            }`}
          >
            {d} days
          </a>
        ))}
      </div>

      {/* ── Masthead ─────────────────────────────────────────────────────── */}
      <header className="avoid-break mb-7 border-b-2 border-neutral-900 pb-4">
        <div className="flex items-end justify-between gap-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-neutral-500">
              Mercato
            </p>
            <h1 className="mt-1 text-[26px] font-bold leading-tight text-neutral-900">
              Usage &amp; spend report
            </h1>
          </div>
          <div className="text-right text-[11px] leading-relaxed text-neutral-600">
            <p className="font-medium text-neutral-900">
              {formatDate(data.since)} – {formatDate(new Date())}
            </p>
            <p>{data.days} days</p>
            <p>Prepared {formatDateTime(new Date())}</p>
            {data.teamScoped && <p className="font-medium">Your team only</p>}
          </div>
        </div>
      </header>

      {/* ── The four numbers someone asks for first ──────────────────────── */}
      <section className="avoid-break mb-7 grid grid-cols-4 gap-4">
        <Kpi
          label="AI spend"
          value={usd(spend)}
          note={measured ? "measured from balance" : "estimated from tokens"}
          strong
        />
        <Kpi label="Billable calls" value={fmt(totalCalls)} note={`${activeDays} active days`} />
        <Kpi
          label="Average / active day"
          value={usd(perActiveDay)}
          note="AI only"
        />
        <Kpi
          label="Failed calls"
          value={fmt(totalFailed)}
          note={totalCalls > 0 ? `${pct(totalFailed / totalCalls)} of all calls` : "—"}
          alert={totalFailed > 0}
        />
      </section>

      {/* ── What the numbers mean, said plainly ──────────────────────────── */}
      <section className="avoid-break mb-7 rounded-lg border border-neutral-300 bg-neutral-50 p-4">
        <h2 className="mb-2 text-[13px] font-semibold text-neutral-900">Summary</h2>
        <ul className="space-y-1.5 text-[12px] leading-relaxed text-neutral-800">
          <li>
            <strong>{usd(spend)}</strong> of AI credit was spent over {data.days} days across{" "}
            <strong>{fmt(kimi?.calls ?? 0)}</strong> model calls
            {measured ? (
              <>
                {" "}
                — taken from the drop in the provider&apos;s own account balance across{" "}
                {data.balanceReadings} readings, so no price list is involved.
              </>
            ) : (
              <> — estimated from token counts at the configured rate.</>
            )}
          </li>
          {aiFeatures[0] && (
            <li>
              The largest consumer was <strong>{FEATURE_LABELS[aiFeatures[0].feature] ?? aiFeatures[0].feature}</strong>,
              at roughly <strong>{pct(aiFeatures[0].share)}</strong> of all tokens processed
              {aiFeatures[1] && (
                <>
                  , followed by {FEATURE_LABELS[aiFeatures[1].feature] ?? aiFeatures[1].feature} at{" "}
                  {pct(aiFeatures[1].share)}
                </>
              )}
              .
            </li>
          )}
          {totalFailed > 0 && (
            <li>
              <strong>{fmt(totalFailed)} calls failed</strong> and were still billed.{" "}
              {worstDay && worstDay.share > 0.4 ? (
                <>
                  {pct(worstDay.share)} of them fell on a single day, {formatYmd(worstDay.day)}, which
                  points at one incident rather than a persistent fault.
                </>
              ) : (
                <>They are spread across the period rather than concentrated in one incident.</>
              )}{" "}
              Their token counts are unknown, so every figure here is a floor, not a ceiling.
            </li>
          )}
          {data.byService
            .filter((s) => s.service !== "kimi")
            .map((s) => (
              <li key={s.service}>
                <strong>{SERVICE_LABELS[s.service]}</strong> consumed {fmt(s.units)}{" "}
                {UNIT_LABELS[s.service] ?? "units"} over {fmt(s.calls)} calls. It is a flat quota
                plan, so it carries no per-call cost.
              </li>
            ))}
        </ul>
      </section>

      {/* ── Services ─────────────────────────────────────────────────────── */}
      <section className="avoid-break mb-7">
        <SectionTitle>Services</SectionTitle>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-[10px] uppercase tracking-wide text-neutral-500">
              <th className="py-1.5 font-semibold">Service</th>
              <th className="py-1.5 font-semibold">What it does</th>
              <th className="py-1.5 text-right font-semibold">Calls</th>
              <th className="py-1.5 text-right font-semibold">Consumed</th>
              <th className="py-1.5 text-right font-semibold">Failed</th>
              <th className="py-1.5 text-right font-semibold">Cost</th>
            </tr>
          </thead>
          <tbody>
            {SERVICES.filter((s) => data.byService.some((r) => r.service === s)).map((service) => {
              const s = data.byService.find((r) => r.service === service)!;
              const isAi = service === "kimi";
              return (
                <tr key={service} className="border-b border-neutral-200">
                  <td className="py-2 font-medium text-neutral-900">
                    <span className="mr-2 inline-block h-2 w-2 rounded-[2px] align-middle"
                      style={{ background: SERIES_COLOR[service] }} />
                    {SERVICE_LABELS[service]}
                  </td>
                  <td className="py-2 text-neutral-600">{SERVICE_ROLE[service]}</td>
                  <td className="py-2 text-right tabular-nums">{fmt(s.calls)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {isAi
                      ? `${tok(s.input)} in / ${tok(s.output)} out`
                      : `${fmt(s.units)} ${UNIT_LABELS[service] ?? ""}`}
                  </td>
                  <td className="py-2 text-right tabular-nums">{s.failed ? fmt(s.failed) : "—"}</td>
                  <td className="py-2 text-right font-medium tabular-nums">
                    {isAi ? usd(measured ? spend : s.estCostUsd) : "quota plan"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* ── Trend ────────────────────────────────────────────────────────── */}
      <section className="avoid-break mb-7 grid grid-cols-2 gap-6">
        <div>
          <SectionTitle>Calls per day</SectionTitle>
          <PrintBars rows={callSeries} series={[...SERVICES]} format={(n) =>
            n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n))} />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-neutral-600">
            {SERVICES.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-[2px]" style={{ background: SERIES_COLOR[s] }} />
                {SERVICE_LABELS[s]}
              </span>
            ))}
          </div>
        </div>
        <div>
          <SectionTitle>AI spend per day</SectionTitle>
          <PrintBars
            rows={spendSeries}
            series={["kimi"]}
            format={(n) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)}
          />
        </div>
      </section>

      {/* ── Page two ─────────────────────────────────────────────────────── */}
      <div className="page-break" />

      <section className="avoid-break mb-7">
        <SectionTitle>Where the AI spend went</SectionTitle>
        <p className="mb-2 text-[11px] text-neutral-600">
          Share of all tokens processed. The balance measures the account as a whole, not each
          feature, so these are proportions of work done rather than billed amounts.
        </p>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-[10px] uppercase tracking-wide text-neutral-500">
              <th className="py-1.5 font-semibold">Feature</th>
              <th className="py-1.5 text-right font-semibold">Calls</th>
              <th className="py-1.5 text-right font-semibold">Tokens</th>
              <th className="w-[34%] py-1.5 pl-4 font-semibold">Share</th>
            </tr>
          </thead>
          <tbody>
            {aiFeatures.map((f) => (
              <tr key={f.feature} className="border-b border-neutral-200">
                <td className="py-2 text-neutral-900">{FEATURE_LABELS[f.feature] ?? f.feature}</td>
                <td className="py-2 text-right tabular-nums">{fmt(f.calls)}</td>
                <td className="py-2 text-right tabular-nums">{tok(f.input + f.output)}</td>
                <td className="py-2 pl-4">
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-200">
                      <span
                        className="block h-full rounded-full"
                        style={{ width: `${Math.max(2, f.share * 100)}%`, background: SERIES_COLOR.kimi }}
                      />
                    </span>
                    <span className="w-9 text-right tabular-nums text-[11px]">{pct(f.share)}</span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {data.byProject.length > 0 && (
        <section className="avoid-break mb-7">
          <SectionTitle>Busiest projects</SectionTitle>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-[10px] uppercase tracking-wide text-neutral-500">
                <th className="py-1.5 font-semibold">Project</th>
                <th className="py-1.5 text-right font-semibold">Calls</th>
                <th className="py-1.5 text-right font-semibold">Tokens</th>
                <th className="py-1.5 text-right font-semibold">Quota units</th>
              </tr>
            </thead>
            <tbody>
              {data.byProject.slice(0, 12).map((p) => (
                <tr key={p.projectId ?? "none"} className="border-b border-neutral-200">
                  <td className="py-2 text-neutral-900">
                    {p.name ?? (p.projectId ? p.projectId.slice(0, 8) : "— no project —")}
                  </td>
                  <td className="py-2 text-right tabular-nums">{fmt(p.calls)}</td>
                  <td className="py-2 text-right tabular-nums">{tok(p.input + p.output)}</td>
                  <td className="py-2 text-right tabular-nums">{p.units ? fmt(p.units) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {data.byModel.length > 0 && (
        <section className="avoid-break mb-7">
          <SectionTitle>Models used</SectionTitle>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-[10px] uppercase tracking-wide text-neutral-500">
                <th className="py-1.5 font-semibold">Model</th>
                <th className="py-1.5 text-right font-semibold">Calls</th>
                <th className="py-1.5 text-right font-semibold">Tokens in</th>
                <th className="py-1.5 text-right font-semibold">Tokens out</th>
              </tr>
            </thead>
            <tbody>
              {data.byModel.map((m) => (
                <tr key={m.model} className="border-b border-neutral-200">
                  <td className="py-2 font-mono text-[11px] text-neutral-900">{m.model}</td>
                  <td className="py-2 text-right tabular-nums">{fmt(m.calls)}</td>
                  <td className="py-2 text-right tabular-nums">{tok(m.input)}</td>
                  <td className="py-2 text-right tabular-nums">{tok(m.output)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ── How to read it ───────────────────────────────────────────────── */}
      <section className="avoid-break border-t border-neutral-300 pt-3 text-[10px] leading-relaxed text-neutral-600">
        <p className="mb-1 font-semibold text-neutral-800">How these figures are produced</p>
        <p>
          Every billable call to a paid provider is recorded at the moment it is made, with the
          feature and project that caused it. Token counts come from the model&apos;s own responses,
          Keepa tokens from the value it returns on each call, and Synccentric searches from its
          quota headers — none of it is inferred.
          {measured ? (
            <>
              {" "}
              The dollar figure is the fall in the provider&apos;s account balance over the period,
              which is the provider&apos;s own arithmetic: no price list is involved and cached
              tokens are already accounted for. Top-ups are ignored rather than netted off, so a
              recharge inside the period cannot hide the spend either side of it.
            </>
          ) : (
            <> The dollar figure is estimated from tokens until two balance readings exist.</>
          )}{" "}
          Keepa and Synccentric are flat quota plans rather than per-call billing, so their usage is
          reported in units; a dollar figure there would be invented. Failed calls are billed but
          report no tokens, so totals are a floor.
        </p>
        <p className="mt-2 text-neutral-500">
          Mercato · generated {formatDateTime(new Date())} · covering{" "}
          {formatDate(data.since)} to {formatDate(new Date())}
        </p>
      </section>
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-neutral-500">
      {children}
    </h2>
  );
}

function Kpi({
  label,
  value,
  note,
  strong,
  alert,
}: {
  label: string;
  value: string;
  note?: string;
  strong?: boolean;
  alert?: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 ${strong ? "border-neutral-900" : "border-neutral-300"}`}>
      <p className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</p>
      <p
        className={`mt-1 font-bold tabular-nums ${strong ? "text-[24px]" : "text-[20px]"} ${
          alert ? "text-red-700" : "text-neutral-900"
        }`}
      >
        {value}
      </p>
      {note && <p className="mt-0.5 text-[10px] text-neutral-500">{note}</p>}
    </div>
  );
}

/**
 * A stacked daily bar, static.
 *
 * The screen's chart carries a hover tooltip, which is meaningless on paper —
 * so this draws the same shape with its axis labelled and nothing interactive.
 */
function PrintBars({
  rows,
  series,
  format,
}: {
  rows: { day: string; values: Record<string, number>; total: number }[];
  series: string[];
  format: (n: number) => string;
}) {
  const peak = Math.max(...rows.map((r) => r.total), 0);
  const max = peak > 0 ? niceMax(peak) : 1;
  const step = rows.length <= 10 ? 1 : rows.length <= 40 ? 5 : 10;

  if (rows.length === 0 || peak === 0) {
    return (
      <div className="flex h-[92px] items-center justify-center rounded border border-dashed border-neutral-300 text-[11px] text-neutral-500">
        Nothing recorded in this window
      </div>
    );
  }

  return (
    <div className="flex gap-1.5">
      <div className="relative h-[92px] w-9 shrink-0 text-[9px] text-neutral-500">
        {[1, 0.5, 0].map((f) => (
          <span key={f} className="absolute right-0 -translate-y-1/2 tabular-nums" style={{ top: `${(1 - f) * 100}%` }}>
            {format(max * f)}
          </span>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative h-[92px] border-b border-neutral-400">
          <div className="absolute inset-x-0 top-0 border-t border-dotted border-neutral-300" />
          <div className="absolute inset-x-0 top-1/2 border-t border-dotted border-neutral-300" />
          <div className="flex h-full items-end gap-[1px]">
            {rows.map((row) => {
              const drawn = [...series].reverse().filter((k) => (row.values[k] ?? 0) > 0);
              return (
                <div key={row.day} className="flex h-full min-w-0 flex-1 flex-col justify-end">
                  {drawn.map((k, i) => (
                    <div
                      key={k}
                      style={{
                        height: `${((row.values[k] ?? 0) / max) * 100}%`,
                        background: SERIES_COLOR[k],
                        borderRadius: i === 0 ? "2px 2px 0 0" : 0,
                        minHeight: 1,
                      }}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </div>
        <div className="mt-1 flex gap-[1px] text-[9px] text-neutral-500">
          {rows.map((r, i) => (
            <div key={r.day} className="min-w-0 flex-1 text-center">
              {i % step === 0 ? <span className="whitespace-nowrap">{shortDay(r.day)}</span> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDay(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${d} ${MONTHS[(m || 1) - 1]}`;
}
function niceMax(v: number): number {
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

/**
 * Print rules.
 *
 * Two things browsers do by default would ruin this: they strip background
 * colours to save ink, which erases every bar and swatch, and they break pages
 * wherever the text happens to run out, which splits tables across sheets. Both
 * are overridden. The report is also pinned to light regardless of the viewer's
 * theme — a dark-mode page prints as a black rectangle.
 */
function PrintStyles() {
  return (
    <style>{`
      .report { color: #171717; background: #fff; }
      .report table { border-collapse: collapse; }
      @media print {
        @page { size: A4 portrait; margin: 14mm; }
        html, body { background: #fff !important; }
        .no-print { display: none !important; }
        .report { max-width: none; }
        .page-break { break-before: page; }
        .avoid-break { break-inside: avoid; }
        * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
      }
    `}</style>
  );
}
