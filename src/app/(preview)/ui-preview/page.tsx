"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle, Clock, Download, FileSpreadsheet, FolderOpen, Package,
  Plus, RefreshCw, Sparkles, Tag, Upload,
} from "lucide-react";
import {
  Card, EmptyState, Notice, PageHeader, Pill, Skeleton, StatRow, StatTile,
} from "@/components/ui/primitives";
import { JobMonitor } from "@/components/ui/job-monitor";
import { CountUp, useReducedMotion } from "@/components/ui/motion";

/**
 * A categorise run, simulated.
 *
 * Paced from the real thing rather than for a pleasing demo: batches land in
 * lumps because that is how batches land, and around two-thirds through it
 * STALLS. The stall is the point — a progress bar looks identical whether or
 * not it is still moving, and the throughput line does not.
 *
 * `speed` exists because both things cannot be true at once. At 1x the figures
 * are truthful — a 1,999-product run really does read "~28 min left" — and
 * nobody will sit through it. Faster is the only way to watch the whole arc,
 * and the estimate then describes the sped-up run, honestly, rather than the
 * real one. Hence the label on the control.
 */
function SimulatedRun() {
  const TOTAL = 1999;
  const [speed, setSpeed] = useState(20);
  const [done, setDone] = useState(0);
  const tick = useRef(0);

  useEffect(() => {
    // Real observed throughput: roughly 70 products a minute, so ~1.2 a
    // second. Ticking twice a second keeps the stall legible.
    const id = setInterval(() => {
      tick.current += 1;
      setDone((d) => {
        if (d >= TOTAL) return 0; // loops, so it can be watched more than once
        const frac = d / TOTAL;
        if (frac > 0.62 && frac < 0.70) return d; // the stall
        const perTick = Math.max(1, Math.round((70 / 60 / 2) * speed));
        const jitter = Math.round((Math.random() - 0.4) * perTick * 0.6);
        return Math.min(TOTAL, d + Math.max(0, perTick + jitter));
      });
    }, 500);
    return () => clearInterval(id);
  }, [speed]);

  return (
    <div>
      <JobMonitor
        label="Categorising"
        phase={done < 300 ? "Resolving SKU-only products…" : "Matching against the Best Buy taxonomy…"}
        done={done}
        total={TOTAL}
      />
      <div className="mt-2 flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">demo speed</span>
        {[1, 20, 60].map((s) => (
          <button
            key={s}
            onClick={() => { setSpeed(s); setDone(0); }}
            className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
              speed === s ? "border-foreground/30 bg-muted" : "border-border hover:bg-muted/50"
            }`}
          >
            {s}×
          </button>
        ))}
        <span className="text-[11px] text-muted-foreground">
          {speed === 1 ? "real pace — the estimate is the true one" : "sped up — the estimate describes this pace"}
        </span>
      </div>
    </div>
  );
}

/**
 * The design system, on one page, with no database behind it.
 *
 * Deliberately outside the (app) route group: no sidebar, no auth, no Prisma.
 * Every page in Mercato is server-rendered from a query, so with Postgres down
 * there is no way to look at a restyled screen — it throws before it paints.
 * This one renders from hardcoded data and works regardless.
 *
 * It also outlives the outage. The reason there are 107 hand-rolled status
 * boxes in this codebase is that nobody could see what already existed; a page
 * that shows it makes reaching for the existing component the easy option.
 *
 *   pnpm dev   →   http://localhost:3000/ui-preview
 */

/** Reports what the OS is asking for, so the behaviour can be checked rather
 *  than assumed. Toggle it in Windows → Settings → Accessibility → Visual
 *  effects → Animation effects, and this flips without a reload. */
function ReducedMotionNote() {
  const reduced = useReducedMotion();
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-sm">
        Your system asks for{" "}
        <span className="font-medium">{reduced ? "reduced motion" : "full motion"}</span>.
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        {reduced
          ? "Counters jump, the sparkline holds still and the status dot stays lit instead of blinking. Nothing above is animating."
          : "Nothing in Mercato checked this before today — 21 spinners, 4 pulses and 38 transitions, none of them asking."}
      </p>
      <p className="mt-3 text-xs tabular-nums text-muted-foreground">
        A counter, for comparison: <CountUp value={reduced ? 1999 : 826} />
      </p>
    </div>
  );
}

function Section({ title, why, children }: { title: string; why: string; children: React.ReactNode }) {
  return (
    <section className="mb-14">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      <p className="mb-4 mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">{why}</p>
      {children}
    </section>
  );
}

/** Marks the old treatment so the two can be compared honestly, side by side. */
function Before({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Before</p>
      {children}
    </div>
  );
}
function After({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-foreground">After</p>
      {children}
    </div>
  );
}

export default function UiPreviewPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <PageHeader
        title="Mercato UI"
        subtitle="Every shared element in one place, rendered without a database. Same palette as today — what changes is that one idea is now drawn one way."
        actions={<Pill tone="accent">preview</Pill>}
      />

      {/* ── The long wait ───────────────────────────────────────────── */}
      <Section
        title="Long-running jobs"
        why="Categorising 1,999 products takes half an hour and shows a spinner. This reports how far, how fast, and how long — all from the progress the run already emits. Watch the throughput line around 65%: the job stalls, and the bar alone would not tell you."
      >
        <SimulatedRun />
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Before>
            <div className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4">
              <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Categorising products…</span>
            </div>
          </Before>
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Reduced motion
            </p>
            <ReducedMotionNote />
          </div>
        </div>
      </Section>

      {/* ── Notices ─────────────────────────────────────────────────── */}
      <Section
        title="Notices"
        why="107 of these are hand-rolled across the app — 37 amber, 21 blue, 19 red, 30 green — each with its own padding, border and icon size. One component, four tones."
      >
        <div className="mb-6 grid gap-4 md:grid-cols-2">
          <Before>
            {/* Verbatim from categorize-step.tsx, so the comparison is fair. */}
            <div className="rounded-2xl bg-amber-50/70 p-4 dark:bg-amber-950/20">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                <div>
                  <p className="text-sm font-semibold text-amber-800">
                    184 products categorized with low confidence
                  </p>
                  <p className="mt-1 text-xs text-amber-700">
                    The AI assigned these a category but wasn&apos;t sure between multiple plausible
                    options — usually because the product name is short or ambiguous.
                  </p>
                </div>
              </div>
            </div>
          </Before>
          <After>
            <Notice tone="warning" title="184 products categorised with low confidence">
              The model picked a category but was torn between plausible options — usually a short or
              ambiguous product name. They are marked <em>Review</em> in the table below.
            </Notice>
          </After>
        </div>

        <div className="space-y-3">
          <Notice tone="critical" title="Kimi has no credit left, so every AI feature is refusing"
            action={<button className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted">Top up</button>}>
            Categorisation, verification and export fills will not run until the account is topped up.
          </Notice>
          <Notice tone="info" title="1,173 products will go to a separate Uncategorized.csv">
            They are not placed into any template file. The other 826 are matched to their templates.
          </Notice>
          <Notice tone="good" title="Every category in this project has a template" />
        </div>
      </Section>

      {/* ── Stat tiles ──────────────────────────────────────────────── */}
      <Section
        title="Stat tiles"
        why="15 variants today. The label now sits above the number: every existing tile put it below, so you meet '1,999' with no idea what it counts and find out afterwards."
      >
        <div className="mb-6 grid gap-4 md:grid-cols-2">
          <Before>
            <div className="grid grid-cols-2 gap-3">
              {[["826", "Categorized"], ["184", "Low confidence"]].map(([n, l]) => (
                <div key={l} className="rounded-2xl bg-green-50/70 p-4 dark:bg-green-950/20">
                  <p className="text-2xl font-bold text-green-700 dark:text-green-400">{n}</p>
                  <p className="text-sm text-muted-foreground">{l}</p>
                </div>
              ))}
            </div>
          </Before>
          <After>
            <div className="grid grid-cols-2 gap-3">
              <StatTile label="Categorised" value="826" tone="good" note="of 1,999" />
              <StatTile label="Low confidence" value="184" tone="warning" note="check before export" />
            </div>
          </After>
        </div>

        <StatRow>
          <StatTile label="Categorised" value="826" tone="good" note="of 1,999" />
          <StatTile label="Low confidence" value="184" tone="warning" selected note="filtering" onClick={() => {}} />
          <StatTile label="Uncategorised" value="989" tone="critical" note="excluded from export" onClick={() => {}} />
          <StatTile label="Total products" value="1,999" />
        </StatRow>
      </Section>

      {/* ── A real screen, rebuilt ──────────────────────────────────── */}
      <Section
        title="Export step, reassembled"
        why="Same information as today, using only the pieces above. The gain is not decoration — it is that the eye lands on the file list, which is the thing you came to check."
      >
        <Card>
          <PageHeader
            as="section"
            title="Export ZIP"
            subtitle="One Excel file per category — templates matched automatically."
            actions={
              <button className="inline-flex items-center gap-2 rounded-lg bg-foreground px-3.5 py-2 text-sm font-medium text-background">
                <Download className="h-4 w-4" /> Download ZIP (11 files)
              </button>
            }
          />
          <StatRow className="mb-5 lg:grid-cols-3">
            <StatTile label="Categories → files" value="11" />
            <StatTile label="Products to export" value="826" />
            <StatTile label="Templates available" value="12" />
          </StatRow>
          <Notice
            tone="warning"
            title="1,173 products will be exported to a separate Uncategorized.csv"
            className="mb-5"
          >
            These are not placed into any template file. Review them below, or remove them from the
            vendor file.
          </Notice>
          <p className="mb-2 text-sm font-medium">Files that will be created</p>
          <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
            {[["Furniture", "301 products"], ["Decor 1", "183 products"], ["Outdoor", "148 products"]].map(
              ([name, count]) => (
                <div key={name} className="flex items-center gap-3 px-4 py-2.5">
                  <FileSpreadsheet className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                  <Pill tone="neutral">Admin</Pill>
                  <span className="w-28 text-right text-xs tabular-nums text-muted-foreground">{count}</span>
                </div>
              ),
            )}
          </div>
        </Card>
      </Section>

      {/* ── Project cards ───────────────────────────────────────────── */}
      <Section title="Project card" why="Tighter type hierarchy, one radius, and the owner line that admins now need.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[
            { name: "VENDOR MS 28TH Sep", mp: "Walmart", n: 4741, tone: "warning" as const, status: "Verifying" },
            { name: "MS-WM 2", mp: "Best Buy", n: 1999, tone: "good" as const, status: "Categorised" },
            { name: "vida_skus_5000", mp: "Mathis", n: 4811, tone: "neutral" as const, status: "Exporting" },
          ].map((p) => (
            <Card key={p.name} className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">{p.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{p.mp}</p>
                </div>
                <Pill tone={p.tone}>{p.status}</Pill>
              </div>
              <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
                <span className="flex items-center gap-1"><Package className="h-3.5 w-3.5" />{p.n.toLocaleString()}</span>
                <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" />28 Sep 16:13</span>
              </div>
              {/* Recessive on purpose: progress is context, not the headline.
                  At foreground/70 it read as the heaviest thing on the card. */}
              <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-foreground/25" style={{ width: "62%" }} />
              </div>
            </Card>
          ))}
        </div>
      </Section>

      {/* ── Empty & loading ─────────────────────────────────────────── */}
      <Section title="Empty and loading" why="Several screens render an empty grid with no explanation, and jump when data lands. A skeleton shaped like the result keeps the layout still.">
        <div className="grid gap-4 md:grid-cols-2">
          <EmptyState
            icon={FolderOpen}
            title="No projects yet"
            action={
              <button className="inline-flex items-center gap-2 rounded-lg bg-foreground px-3.5 py-2 text-sm font-medium text-background">
                <Plus className="h-4 w-4" /> New project
              </button>
            }
          >
            Upload a vendor spreadsheet and Mercato will match it to a marketplace template.
          </EmptyState>
          <Card>
            <div className="space-y-3">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/4" />
              <div className="grid grid-cols-3 gap-3 pt-2">
                <Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" />
              </div>
            </div>
          </Card>
        </div>
      </Section>

      {/* ── Pills ───────────────────────────────────────────────────── */}
      <Section title="Status pills" why="Used on cards, in tables and beside file names. One shape, four tones.">
        <div className="flex flex-wrap gap-2">
          <Pill tone="good" icon={Sparkles}>Categorised</Pill>
          <Pill tone="warning" icon={AlertTriangle}>Low confidence</Pill>
          <Pill tone="critical" icon={AlertTriangle}>Failed</Pill>
          <Pill tone="neutral" icon={Upload}>Uploaded</Pill>
          <Pill tone="neutral" icon={RefreshCw}>Verifying</Pill>
          <Pill tone="accent" icon={Tag}>Best Buy</Pill>
        </div>
      </Section>
    </div>
  );
}

