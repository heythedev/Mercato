import * as React from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The pieces every screen was building for itself.
 *
 * Counted across src before this file existed: 107 hand-rolled status boxes
 * (37 amber, 21 blue, 19 red, 30 green), 15 hand-rolled stat tiles, and three
 * competing corner radii — rounded-lg 101 times, rounded-2xl 40, rounded-xl 30
 * — against exactly two shared components in the whole app.
 *
 * That is what makes Mercato read as assembled rather than designed. Not the
 * palette: the same idea rendered five slightly different ways depending on
 * which screen you are standing on. A warning on Categorize is a 2xl tinted
 * panel with a 5px icon; on Export it is a bordered box with a 4px icon. Both
 * are fine. Together they look careless.
 *
 * So these change no colour. They take the tokens globals.css already defines
 * — including --status-good/warning/critical, which were declared and then
 * barely used — and make one decision per element, once.
 */

// ── Surfaces ────────────────────────────────────────────────────────────────

/**
 * One card. One radius.
 *
 * `--radius` (10px) and its scale already existed in globals.css; almost
 * nothing referenced them, so the app drifted to three literal radii instead.
 * rounded-xl here IS that token.
 */
export function Card({
  className,
  inset = true,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { inset?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card",
        inset && "p-5",
        className,
      )}
      {...props}
    />
  );
}

// ── Notices ─────────────────────────────────────────────────────────────────

export type NoticeTone = "info" | "warning" | "critical" | "good";

const NOTICE: Record<NoticeTone, { icon: LucideIcon; ring: string; tint: string; mark: string }> = {
  // Tinted surface + matching hairline, rather than a heavy border. The old
  // boxes alternated between a 2px coloured border and no border at all.
  info: { icon: Info, ring: "border-sky-200 dark:border-sky-900/60", tint: "bg-sky-50 dark:bg-sky-950/25", mark: "text-sky-600 dark:text-sky-400" },
  warning: { icon: AlertTriangle, ring: "border-amber-200 dark:border-amber-900/60", tint: "bg-amber-50 dark:bg-amber-950/25", mark: "text-amber-600 dark:text-amber-400" },
  critical: { icon: XCircle, ring: "border-red-200 dark:border-red-900/60", tint: "bg-red-50 dark:bg-red-950/25", mark: "text-red-600 dark:text-red-400" },
  good: { icon: CheckCircle2, ring: "border-emerald-200 dark:border-emerald-900/60", tint: "bg-emerald-50 dark:bg-emerald-950/25", mark: "text-emerald-600 dark:text-emerald-400" },
};

/**
 * Something the screen needs to tell you.
 *
 * `title` carries the fact and `children` the explanation, because the old
 * boxes mixed the two: some led with a sentence of background before the
 * number, which is the wrong way round when a person is scanning.
 */
export function Notice({
  tone = "info",
  title,
  icon,
  action,
  children,
  className,
}: {
  tone?: NoticeTone;
  title: React.ReactNode;
  /** Override only when a specific icon says more than the tone's default. */
  icon?: LucideIcon;
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  const t = NOTICE[tone];
  const Icon = icon ?? t.icon;
  return (
    <div className={cn("rounded-xl border p-4", t.ring, t.tint, className)}>
      <div className="flex items-start gap-3">
        <Icon className={cn("mt-px h-4 w-4 shrink-0", t.mark)} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug text-foreground">{title}</p>
          {children ? (
            <div className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{children}</div>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
}

// ── Stat tiles ──────────────────────────────────────────────────────────────

export type StatTone = "neutral" | "good" | "warning" | "critical" | "accent";

const STAT_INK: Record<StatTone, string> = {
  neutral: "text-foreground",
  good: "text-[var(--status-good)]",
  warning: "text-[var(--status-warning)]",
  critical: "text-[var(--status-critical)]",
  accent: "text-[var(--series-kimi)]",
};

/**
 * One number, its name, and optionally what it means.
 *
 * The label goes ABOVE the number. Every existing tile put it below, which
 * reads as a caption on something you have already had to interpret — you meet
 * "1,999" with no idea what it counts, then find out. Small, and it is most of
 * why a row of tiles feels harder to read than it should.
 *
 * Selectable tiles (Categorize filters by clicking one) get a real pressed
 * state rather than a ring bolted on, and a button element rather than a div.
 */
export function StatTile({
  label,
  value,
  note,
  tone = "neutral",
  selected,
  onClick,
  className,
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  tone?: StatTone;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const body = (
    <>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn("mt-1.5 text-[26px] font-semibold leading-none tabular-nums", STAT_INK[tone])}>
        {value}
      </p>
      {note ? <p className="mt-1.5 text-xs leading-snug text-muted-foreground">{note}</p> : null}
    </>
  );

  const shell = cn(
    "rounded-xl border p-4 text-left transition-colors",
    selected ? "border-foreground/30 bg-muted/60" : "border-border bg-card",
    onClick && "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20",
    className,
  );

  if (!onClick) return <div className={shell}>{body}</div>;
  return (
    <button type="button" onClick={onClick} aria-pressed={selected} className={shell}>
      {body}
    </button>
  );
}

/** A row of tiles that stays readable on a phone. */
export function StatRow({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4", className)}>
      {children}
    </div>
  );
}

// ── Page furniture ──────────────────────────────────────────────────────────

/**
 * The same header on every screen.
 *
 * Nine screens currently each style their own title: different sizes, some
 * with a subtitle, some with actions inline, some with actions in a row below.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  /**
   * `section` for a header INSIDE a card. The page-level size is too loud
   * there, and an <h1> nested in a panel is wrong twice over — visually and
   * for anyone navigating by headings, who would hear several page titles on
   * one page.
   */
  as = "page",
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  as?: "page" | "section";
  className?: string;
}) {
  const Heading = as === "page" ? "h1" : "h2";
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4",
        as === "page" ? "mb-6" : "mb-5",
        className,
      )}
    >
      <div className="min-w-0">
        <Heading
          className={cn(
            "font-semibold leading-tight tracking-tight",
            as === "page" ? "text-xl" : "text-base",
          )}
        >
          {title}
        </Heading>
        {subtitle ? (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/**
 * Nothing here yet.
 *
 * An empty screen should say what would fill it and how, not just sit blank —
 * several screens currently render an empty grid with no explanation at all.
 */
export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: React.ReactNode;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-dashed border-border px-6 py-14 text-center", className)}>
      {Icon ? (
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-muted">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
      ) : null}
      <p className="text-sm font-medium">{title}</p>
      {children ? (
        <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-muted-foreground">{children}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

/**
 * A loading placeholder shaped like the thing that is coming.
 *
 * The app currently shows a spinner or nothing at all, so the page jumps when
 * data lands. A skeleton of roughly the right shape keeps the layout still.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} />;
}

/** A small status word with its own colour, used in tables and on cards. */
export function Pill({
  tone = "neutral",
  icon: Icon,
  children,
  className,
}: {
  tone?: StatTone;
  icon?: LucideIcon;
  children: React.ReactNode;
  className?: string;
}) {
  const tint: Record<StatTone, string> = {
    neutral: "bg-muted text-muted-foreground",
    good: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
    warning: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
    critical: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300",
    accent: "bg-muted text-foreground",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        tint[tone],
        className,
      )}
    >
      {Icon ? <Icon className="h-3 w-3" /> : null}
      {children}
    </span>
  );
}
