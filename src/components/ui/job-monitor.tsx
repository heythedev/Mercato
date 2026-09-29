"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { CountUp, Sparkline, useReducedMotion } from "./motion";

/**
 * What a long-running job actually looks like.
 *
 * Categorising 1,999 products takes about half an hour and currently shows a
 * spinner and a sentence. A spinner asserts that something is happening. It
 * cannot tell you what, how fast, or whether it is still true — and this week
 * a run sat "in progress" for twenty minutes after every write had started
 * failing, looking exactly as it had when it was working.
 *
 * So this reports three things a spinner cannot:
 *
 *   how far     the count and the bar
 *   how fast    throughput per minute, and its recent shape
 *   how long    an estimate derived from the rate actually observed
 *
 * The rate history is the one that matters. A progress bar that has stopped
 * looks patient; a throughput line that has stopped looks wrong. That is the
 * whole argument for the sparkline, and it is why this is not decoration.
 *
 * Everything is derived from `done` and `total`. The caller reports progress
 * it already emits — no new plumbing.
 */

type Sample = { at: number; done: number };

/** Kept short so the rate reflects now, not the average since the job began:
 *  a run that has just stalled should read as stalled within a minute. */
const WINDOW_MS = 90_000;
const MAX_BARS = 20;

/**
 * Before this much has passed, no estimate is offered.
 *
 * A figure derived from two samples three seconds apart is arithmetic, not an
 * estimate — it swings between "4 minutes" and "40 minutes" on consecutive
 * ticks and teaches people to ignore it. Better to say nothing for ten seconds
 * than to say something untrue twice.
 */
const MIN_MS_BEFORE_ETA = 10_000;
const MIN_SAMPLES_BEFORE_ETA = 3;

/**
 * Smoothing for the estimate only.
 *
 * The sparkline plots the RAW rate, because its job is to show the stall the
 * moment it happens. The estimate uses an exponentially weighted average of
 * the same numbers, because its job is to be worth reading — an ETA that
 * lurches every three seconds is noise wearing a number's clothes.
 *
 * 0.25 leans on history: recent samples move it, one slow batch does not.
 */
const ETA_SMOOTHING = 0.25;

/** "less than a minute" · "~7 min" · "~1 hr 20 min" — never "~73 min". */
function formatEta(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `~${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m === 0 ? `~${h} hr` : `~${h} hr ${m} min`;
}

/** Per minute while that reads sensibly, per hour once it does not. */
function formatRate(perMin: number): string {
  if (perMin <= 0) return "—";
  if (perMin < 1) return `${Math.round(perMin * 60).toLocaleString()}/hr`;
  return `${Math.round(perMin).toLocaleString()}/min`;
}

export function JobMonitor({
  label,
  phase,
  done,
  total,
  unit = "products",
  detail,
  className,
}: {
  label: string;
  /** The stage in words — "Resolving SKU-only products", "Building files". */
  phase?: string;
  done: number;
  total: number;
  unit?: string;
  /** Anything job-specific: "4 of 13 batches in flight". */
  detail?: React.ReactNode;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const [rates, setRates] = useState<number[]>([]);
  const [smoothed, setSmoothed] = useState<number | null>(null);
  // How many samples, and when the first arrived. State rather than a ref
  // because render reads it — the React Compiler refuses a ref there, and it
  // is right to: a ref read during render is invisible to it and can hold a
  // value from a render that was thrown away.
  const [history, setHistory] = useState<{ samples: number; firstAt: number; lastAt: number } | null>(
    null,
  );
  const samples = useRef<Sample[]>([]);
  const lastDone = useRef(done);

  useEffect(() => {
    // Only record when the figure actually moves. A parent re-rendering every
    // poll would otherwise stuff the window with identical samples and drag
    // the computed rate toward zero while the job is perfectly healthy.
    if (done === lastDone.current) return;
    lastDone.current = done;

    const now = Date.now();
    const kept = [...samples.current, { at: now, done }].filter((s) => now - s.at <= WINDOW_MS);
    samples.current = kept;
    setHistory((prev) => ({
      samples: (prev?.samples ?? 0) + 1,
      firstAt: prev?.firstAt ?? now,
      lastAt: now,
    }));

    if (kept.length >= 2) {
      const first = kept[0];
      const last = kept[kept.length - 1];
      const minutes = (last.at - first.at) / 60_000;
      const rate = minutes > 0 ? Math.max(0, (last.done - first.done) / minutes) : 0;
      setRates((prev) => [...prev, rate].slice(-MAX_BARS));
      setSmoothed((prev) => (prev == null ? rate : prev + ETA_SMOOTHING * (rate - prev)));
    }
  }, [done]);

  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const rate = rates.length ? rates[rates.length - 1] : 0;
  const remaining = Math.max(0, total - done);

  // Withheld until there is enough history to mean anything, and dropped again
  // the moment throughput reaches zero — an estimate computed from a stalled
  // rate is either infinity or a stale number quietly going out of date, and
  // both are worse than saying "stalled".
  // Between the first and latest SAMPLE, not "until now". Pure — render reads
  // only state — and more truthful besides: it measures how long we have been
  // watching progress, not how long the component has been mounted.
  const observedMs = history ? history.lastAt - history.firstAt : 0;
  const settled = (history?.samples ?? 0) >= MIN_SAMPLES_BEFORE_ETA && observedMs >= MIN_MS_BEFORE_ETA;
  const stalled = settled && rate === 0;
  const etaMin = settled && !stalled && smoothed && smoothed > 0 ? remaining / smoothed : null;

  return (
    <div className={cn("rounded-xl border border-border bg-card p-4", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-medium">
          {label}
          {/* A dot that breathes, rather than a spinner that whirls. At this
              size a spinner is the loudest thing on the screen, and it is the
              least informative. */}
          <span
            className={cn(
              "ml-2 inline-block h-1.5 w-1.5 rounded-full bg-[var(--status-good)] align-middle",
              !reduced && "animate-pulse",
            )}
            aria-hidden
          />
        </p>
        <p className="text-sm tabular-nums text-muted-foreground">
          <span className="font-medium text-foreground">
            <CountUp value={done} />
          </span>{" "}
          of {total.toLocaleString()} {unit}
        </p>
      </div>

      {phase ? <p className="mt-0.5 text-xs text-muted-foreground">{phase}</p> : null}

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full bg-foreground/70", !reduced && "transition-[width] duration-500 ease-out")}
          style={{ width: `${Math.max(1, pct)}%` }}
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label}: ${done} of ${total} ${unit}`}
        />
      </div>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="flex items-end gap-3">
          {rates.length >= 2 ? <Sparkline values={rates} label="Throughput, last 90 seconds" /> : null}
          <div>
            <p className="text-sm font-medium tabular-nums leading-none">{formatRate(rate)}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">throughput</p>
          </div>
        </div>

        <div className="text-right">
          <p
            className={cn(
              "text-sm font-medium tabular-nums leading-none",
              stalled && "text-[var(--status-warning)]",
            )}
          >
            {stalled ? "stalled" : !settled ? "estimating…" : `${formatEta(etaMin ?? 0)} left`}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {/* Named as an observation, not a promise: extrapolated from the
                last 90 seconds, and it moves when the rate does. */}
            {stalled ? "no progress in the last 90s" : !settled ? "gathering a rate" : "at the current rate"}
          </p>
        </div>
      </div>

      {detail ? <p className="mt-3 text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

