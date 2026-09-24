/**
 * The chart series colours, as literal hex.
 *
 * Everything on screen reads these through CSS custom properties
 * (`var(--series-kimi)`), which is what keeps the charts, the tables and the
 * service cards in step. A PDF has no CSS, so the PDF report needs the values
 * themselves — and the moment a second copy exists, the two can drift.
 *
 * So this module is the copy, globals.css is the original, and
 * series-colors.test.ts parses globals.css and fails if they disagree. Change
 * the CSS, run the tests, and the test tells you to change this too.
 */

/** Light surface. The report is a document: it is always on white. */
export const SERIES_HEX: Record<string, string> = {
  kimi: "#8b5cf6",
  keepa: "#e76f51",
  synccentric: "#2a9d8f",
};

/** Dark surface, for completeness — stepped for it, not flipped from above. */
export const SERIES_HEX_DARK: Record<string, string> = {
  kimi: "#9070ee",
  keepa: "#dd6b4f",
  synccentric: "#22a48f",
};

/** Ink and rules for the printed report, matching the on-screen neutrals. */
export const REPORT_INK = {
  text: "#171717",
  muted: "#525252",
  faint: "#737373",
  rule: "#d4d4d4",
  ruleStrong: "#171717",
  panel: "#fafafa",
  panelEdge: "#d4d4d4",
  track: "#e5e5e5",
  alert: "#b91c1c",
} as const;
