import { AlertTriangle, Ban, CheckCircle2, HelpCircle, XCircle } from "lucide-react";
import type { ElementType } from "react";

/**
 * How a product's verification verdict looks, defined once.
 *
 * The same five verdicts were styled in four separate places — `STATUS_BADGE`
 * in products-table, and `STATUS_CONFIG`, `AI_NOTE_STYLE` and `FIELD_SEVERITY`
 * in verify-step — so the product table and the verify screen could disagree
 * about what "warning" looks like, and adding a verdict meant remembering all
 * four. The AI-note map had also drifted: it carried dark-mode variants for its
 * wrapper while every badge in the other three was light-only, which on a dark
 * page put dark green text on a pale green pill.
 *
 * These are VERDICTS about a product (does the live listing match the vendor
 * row?), which is a different axis from a project's pipeline status
 * (uploaded → verifying → done) in projects-view. The two deliberately do not
 * share a palette: one is a judgement, the other is progress.
 */
export type Verdict = "ok" | "warning" | "mismatch" | "not_found" | "discontinued";

export type VerdictStyle = {
  label: string;
  icon: ElementType;
  /** Pill: background + text, both modes. */
  badge: string;
  /** Solid dot / bar, for the marker beside an AI note. */
  dot: string;
  /** Tinted wrapper behind an AI note. */
  note: string;
  /** Body text inside a tinted note. */
  noteText: string;
  /** Text-only severity, for a field row that needs no background. */
  field: string;
};

export const VERDICT: Record<Verdict, VerdictStyle> = {
  ok: {
    label: "Match",
    icon: CheckCircle2,
    badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
    dot: "bg-emerald-500",
    note: "bg-emerald-50/70 dark:bg-emerald-950/20",
    noteText: "text-emerald-900 dark:text-emerald-200",
    field: "text-emerald-600 dark:text-emerald-400",
  },
  warning: {
    label: "Warning",
    icon: AlertTriangle,
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
    dot: "bg-amber-500",
    note: "bg-amber-50/70 dark:bg-amber-950/20",
    noteText: "text-amber-900 dark:text-amber-200",
    field: "text-amber-600 dark:text-amber-400",
  },
  mismatch: {
    label: "Mismatch",
    icon: XCircle,
    badge: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
    dot: "bg-red-500",
    note: "bg-red-50/70 dark:bg-red-950/20",
    noteText: "text-red-900 dark:text-red-200",
    field: "text-red-600 dark:text-red-400",
  },
  not_found: {
    label: "Not found",
    icon: HelpCircle,
    // Slate, not red: not finding a listing is an absence of evidence, not a
    // verdict against the product.
    badge: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    dot: "bg-slate-400",
    note: "bg-slate-50/70 dark:bg-slate-900/40",
    noteText: "text-slate-900 dark:text-slate-200",
    field: "text-slate-600 dark:text-slate-400",
  },
  discontinued: {
    label: "Discontinued",
    icon: Ban,
    badge: "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-300",
    dot: "bg-purple-500",
    note: "bg-purple-50/70 dark:bg-purple-950/20",
    noteText: "text-purple-900 dark:text-purple-200",
    field: "text-purple-600 dark:text-purple-400",
  },
};

/** The style for a verdict string of unknown provenance, never undefined. */
export function verdictStyle(value: string | null | undefined): VerdictStyle {
  return VERDICT[(value ?? "") as Verdict] ?? VERDICT.not_found;
}
