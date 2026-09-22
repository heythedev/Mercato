"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Chart parts for the admin usage report.
 *
 * Deliberately hand-built rather than pulling in a charting library: the page
 * needs two forms (a stacked daily bar and a single-series daily bar) and an
 * inline proportion bar, none of which justify shipping a plotting runtime to
 * every admin. Bars are HTML boxes rather than SVG because a flex column scales
 * to any container width without the corner-radius distortion `preserveAspect`
 * would introduce.
 *
 * Colours come from the --series-* tokens in globals.css — one fixed hue per
 * service, assigned by identity and never by rank, so filtering the range can
 * never repaint a series.
 */

/** Fixed hue order. A service always keeps its own colour across every chart. */
export const SERIES_COLOR: Record<string, string> = {
  kimi: "var(--series-kimi)",
  keepa: "var(--series-keepa)",
  synccentric: "var(--series-synccentric)",
};

export type StackRow = {
  /** Bucket key — YYYY-MM-DD. */
  day: string;
  /** Value per series key; missing keys count as zero. */
  values: Record<string, number>;
  total: number;
};

/** Short axis label: "Sep 18". Parsed as parts, not Date, so the YYYY-MM-DD the
 *  server already rendered in the report timezone is not shifted back to UTC. */
export function shortDay(day: string): string {
  const [, m, d] = day.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[(m ?? 1) - 1]} ${d}`;
}

/** A tick every Nth column, so 90 days of labels never collide. */
function tickEvery(count: number): number {
  return count <= 10 ? 1 : count <= 20 ? 2 : count <= 40 ? 5 : 10;
}

/** Round a maximum up to a readable axis top (1/2/5 × 10ⁿ). */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

type ChartProps = {
  rows: StackRow[];
  /** Series keys, drawn bottom-to-top in this order. */
  series: string[];
  labels: Record<string, string>;
  /** Formats a value for the axis and the tooltip. */
  format: (n: number) => string;
  /** Extra lines under the tooltip's total, per bucket. */
  detail?: (row: StackRow) => { label: string; value: string }[];
  emptyNote?: string;
};

/**
 * Daily bars, stacked by service when more than one series is present.
 *
 * Every series here is measured in the SAME unit (calls, or dollars) — mixing
 * dollars and token counts onto one scale is the reason this is two charts
 * rather than one with two axes.
 */
export function DailyBars({ rows, series, labels, format, detail, emptyNote }: ChartProps) {
  const [active, setActive] = useState<number | null>(null);

  const max = useMemo(() => niceMax(Math.max(...rows.map((r) => r.total), 0)), [rows]);
  const step = tickEvery(rows.length);

  if (rows.length === 0) {
    return (
      <div className="px-4 py-10 text-center text-sm text-muted-foreground">
        {emptyNote ?? "Nothing recorded in this window."}
      </div>
    );
  }

  const hovered = active === null ? null : rows[active];

  return (
    <div className="px-4 pb-3 pt-4">
      <div className="flex gap-2">
        {/* Axis gutter. Three recessive ticks is enough to read magnitude; the
            exact figures live in the tooltip and the table below. */}
        <div className="relative w-14 shrink-0 h-44 text-[10px] text-muted-foreground">
          {[1, 0.5, 0].map((f) => (
            <span
              key={f}
              className="absolute right-0 -translate-y-1/2 tabular-nums"
              style={{ top: `${(1 - f) * 100}%` }}
            >
              {format(max * f)}
            </span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          {/* Gridlines sit behind the marks and carry no labels of their own. */}
          <div className="pointer-events-none absolute inset-0 h-44">
            {[0, 0.5, 1].map((f) => (
              <div
                key={f}
                className="absolute inset-x-0 border-t"
                style={{ top: `${f * 100}%`, borderColor: "var(--viz-grid)" }}
              />
            ))}
          </div>

          <div
            className="relative flex h-44 items-end gap-[2px]"
            onMouseLeave={() => setActive(null)}
          >
            {rows.map((row, i) => (
              <div
                key={row.day}
                className="group relative flex h-full min-w-0 flex-1 cursor-default flex-col justify-end"
                onMouseEnter={() => setActive(i)}
              >
                {/* Hit target spans the full column height, not just the bar —
                    a 2px-tall bar is otherwise impossible to hover. */}
                <div
                  className={cn(
                    "absolute inset-0 rounded-sm transition-colors",
                    active === i && "bg-muted/60",
                  )}
                />
                {/* Stacked top-down so the first series ends up at the bottom.
                    Only the segments that actually have a value are drawn, so
                    the rounded end and the baseline anchor land on real marks. */}
                {(() => {
                  const drawn = [...series].reverse().filter((k) => (row.values[k] ?? 0) > 0);
                  return drawn.map((key, ri) => (
                    <div
                      key={key}
                      className="relative w-full"
                      style={{
                        height: `${((row.values[key] ?? 0) / max) * 100}%`,
                        background: SERIES_COLOR[key] ?? "var(--series-kimi)",
                        // 4px rounded data-end on the top of the stack only; the
                        // segments below stay square so the stack reads as one bar.
                        borderRadius: ri === 0 ? "4px 4px 0 0" : 0,
                        // 2px of surface between segments, so adjacent fills never
                        // blend into one block. The lowest segment sits flat on
                        // the baseline — a gap there would read as a value.
                        marginBottom: ri === drawn.length - 1 ? 0 : 2,
                        minHeight: 2,
                      }}
                    />
                  ));
                })()}
              </div>
            ))}

            {hovered && (
              <div
                className="pointer-events-none absolute bottom-full z-10 mb-2 w-max max-w-[220px] rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg"
                style={{
                  left: `${((active! + 0.5) / rows.length) * 100}%`,
                  // Keep the card inside the plot at both ends.
                  transform: `translateX(${
                    active! < rows.length * 0.12 ? "-10%" : active! > rows.length * 0.88 ? "-90%" : "-50%"
                  })`,
                }}
              >
                <div className="font-medium">{shortDay(hovered.day)}</div>
                <div className="mt-1.5 space-y-1">
                  {series
                    .filter((k) => (hovered.values[k] ?? 0) > 0)
                    .map((k) => (
                      <div key={k} className="flex items-center gap-2 whitespace-nowrap">
                        <span
                          className="h-2 w-2 shrink-0 rounded-[2px]"
                          style={{ background: SERIES_COLOR[k] }}
                        />
                        <span className="text-muted-foreground">{labels[k] ?? k}</span>
                        <span className="ml-auto tabular-nums font-medium">
                          {format(hovered.values[k] ?? 0)}
                        </span>
                      </div>
                    ))}
                  {hovered.total === 0 && <div className="text-muted-foreground">No activity</div>}
                </div>
                {detail?.(hovered).map((d) => (
                  <div
                    key={d.label}
                    className="mt-1 flex items-center gap-3 whitespace-nowrap border-t pt-1 text-muted-foreground"
                  >
                    <span>{d.label}</span>
                    <span className="ml-auto tabular-nums">{d.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t" style={{ borderColor: "var(--viz-axis)" }} />

          <div className="relative mt-1.5 flex gap-[2px] text-[10px] text-muted-foreground">
            {rows.map((row, i) => (
              <div key={row.day} className="min-w-0 flex-1 text-center">
                {i % step === 0 ? <span className="whitespace-nowrap">{shortDay(row.day)}</span> : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Identity is never colour alone: a legend for every multi-series chart,
          and four or fewer series are also named in the tooltip. */}
      {series.length > 1 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 pl-16 text-xs text-muted-foreground">
          {series.map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: SERIES_COLOR[k] }} />
              {labels[k] ?? k}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The share one row holds of its table's largest row, drawn behind the label.
 *
 * A column of right-aligned numbers makes you compare digits; this makes the
 * dominant feature or project visible without reading any of them.
 */
export function ProportionBar({
  fraction,
  color = "var(--series-kimi)",
}: {
  fraction: number;
  color?: string;
}) {
  return (
    <span className="mt-1 block h-1 w-full max-w-[160px] overflow-hidden rounded-full bg-muted">
      <span
        className="block h-full rounded-full"
        style={{ width: `${Math.max(2, Math.min(100, fraction * 100))}%`, background: color }}
      />
    </span>
  );
}

/**
 * Bucket the report's (day, service) rows into one record per calendar day,
 * filling days with no activity so a gap reads as a gap rather than closing up.
 */
export function toDailySeries<T extends { day: string; service: string }>(
  rows: T[],
  value: (r: T) => number,
  days: number,
  timeZone = "Asia/Kolkata",
): StackRow[] {
  const byDay = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const bucket = byDay.get(r.day) ?? {};
    bucket[r.service] = (bucket[r.service] ?? 0) + value(r);
    byDay.set(r.day, bucket);
  }

  // Walk back from today in the same zone the server grouped by, so the last
  // column is "today" and not a day either side of it.
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const out: StackRow[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const key = fmt.format(new Date(Date.now() - i * 86_400_000));
    const values = byDay.get(key) ?? {};
    out.push({ day: key, values, total: Object.values(values).reduce((a, b) => a + b, 0) });
  }
  return out;
}
