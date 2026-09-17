"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

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
  byDay: (Row & { day: string; service: string })[];
  byService: (Row & { service: string })[];
  byFeature: (Row & { service: string; feature: string })[];
  byProject: (Row & { projectId: string | null; name: string | null })[];
  byModel: (Row & { model: string })[];
};

const RANGES = [7, 30, 90] as const;

const fmt = (n: number) => n.toLocaleString();
const usd = (n: number | null) => (n === null ? "—" : `$${n.toFixed(2)}`);
/** Tokens read better in millions once a sweep has run. */
const tok = (n: number) => (n === 0 ? "—" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : fmt(n));
const unit = (n: number) => (n === 0 ? "—" : fmt(n));

const SERVICE_LABELS: Record<string, string> = {
  kimi: "Kimi (AI)",
  keepa: "Keepa",
  synccentric: "Synccentric",
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

export function AdminUsageClient() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
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

  const reload = useCallback(() => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  }, []);

  const selectRange = useCallback((r: number) => {
    setLoading(true);
    setDays(r);
  }, []);

  const empty = data && data.byService.length === 0;
  const failed = data?.byService.reduce((a, s) => a + (s.failed ?? 0), 0) ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border overflow-hidden">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => selectRange(r)}
              className={cn(
                "px-3 py-1.5 text-sm transition-colors",
                days === r ? "bg-foreground text-background" : "hover:bg-muted",
              )}
            >
              {r}d
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
      </div>

      {error && (
        <div className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {data?.setupRequired && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-4 text-sm text-amber-900">
          <p className="font-medium">Usage recording is not set up yet.</p>
          <p className="mt-1">
            The code is deployed, but its table has not been created. This database sits behind a
            connection pooler that Prisma&apos;s migration engine cannot drive, so the table is
            created by a script instead. Run this once, from a machine with the project checked out:
          </p>
          <code className="mt-2 block rounded bg-amber-100 px-2 py-1 font-mono text-xs">
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

      {data && !empty && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            {data.byService.map((s) => (
              <div key={s.service} className="rounded-lg border px-4 py-3">
                <div className="text-xs text-muted-foreground">{SERVICE_LABELS[s.service] ?? s.service}</div>
                <div className="text-xl font-semibold mt-0.5">
                  {s.service === "kimi" ? usd(s.estCostUsd) : `${fmt(s.units)}`}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  {s.service === "kimi"
                    ? `${fmt(s.calls)} calls · ${tok(s.input)} in / ${tok(s.output)} out`
                    : `${fmt(s.calls)} calls · ${UNIT_LABELS[s.service] ?? "units"}`}
                </div>
              </div>
            ))}
          </div>

          {failed > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                <strong>{fmt(failed)}</strong> calls failed in this window. Failed calls are still
                billed, and their token counts are unknown — so the figures above are a floor, not a
                ceiling.
              </span>
            </div>
          )}

          <Table
            title="By day"
            head={["Day", "Service", "Calls", "In", "Out", "Units", "Failed", "Est. cost"]}
            rows={data.byDay.map((r) => [
              r.day,
              SERVICE_LABELS[r.service] ?? r.service,
              fmt(r.calls),
              tok(r.input),
              tok(r.output),
              unit(r.units),
              r.failed ? fmt(r.failed) : "—",
              usd(r.estCostUsd),
            ])}
          />

          <Table
            title="By feature"
            head={["Feature", "Service", "Calls", "In", "Out", "Units"]}
            rows={data.byFeature.map((r) => [
              FEATURE_LABELS[r.feature] ?? r.feature,
              SERVICE_LABELS[r.service] ?? r.service,
              fmt(r.calls),
              tok(r.input),
              tok(r.output),
              unit(r.units),
            ])}
          />

          <Table
            title="By project"
            head={["Project", "Calls", "In", "Out", "Units", "Est. AI cost"]}
            rows={data.byProject.map((r) => [
              r.name ?? (r.projectId ? r.projectId.slice(0, 8) : "— no project —"),
              fmt(r.calls),
              tok(r.input),
              tok(r.output),
              unit(r.units),
              usd(r.estCostUsd),
            ])}
          />

          <Table
            title="By model"
            head={["Model", "Calls", "In", "Out", "Est. cost"]}
            rows={data.byModel.map((r) => [
              r.model,
              fmt(r.calls),
              tok(r.input),
              tok(r.output),
              usd(r.estCostUsd),
            ])}
          />

          <p className="text-xs text-muted-foreground">
            Counts are measured — tokens come from Kimi&apos;s own responses, Keepa tokens from its
            <code className="rounded bg-muted px-1 mx-1">tokensConsumed</code> field, and Synccentric
            searches from its quota headers. Dollar figures apply only to Kimi, which bills per
            token; set <code className="rounded bg-muted px-1">KIMI_PRICE_INPUT_PER_M</code> and{" "}
            <code className="rounded bg-muted px-1">KIMI_PRICE_OUTPUT_PER_M</code> from the billing
            page to make them exact. Keepa and Synccentric are quota plans, so their spend is shown
            in units rather than invented dollars.
          </p>
        </>
      )}
    </div>
  );
}

function Table({ title, head, rows }: { title: string; head: string[]; rows: string[][] }) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border overflow-hidden">
      <div className="border-b bg-muted/40 px-4 py-2 text-sm font-medium">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-muted-foreground">
              {head.map((h, i) => (
                <th key={h} className={cn("px-4 py-2 font-medium", i === 0 ? "text-left" : "text-right")}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-b last:border-0">
                {r.map((c, ci) => (
                  <td
                    key={ci}
                    className={cn("px-4 py-2", ci === 0 ? "text-left" : "text-right tabular-nums")}
                  >
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
