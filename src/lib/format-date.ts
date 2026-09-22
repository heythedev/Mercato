/**
 * Dates that render identically on the server and in the browser.
 *
 * `toLocaleDateString()` with no locale uses whatever the runtime happens to be
 * set to — the server's during SSR, the viewer's during hydration. The two
 * disagree, React finds the server-rendered text does not match, and it throws
 * the whole tree away and re-renders on the client. That is exactly what broke
 * /admin/users:
 *
 *   "Hydration failed because the server rendered text didn't match the client."
 *
 * The bug is invisible in a screenshot — the page looks right, because the
 * client re-render produces the correct output — which is why it survived. It
 * costs a full client re-render of the subtree on every load.
 *
 * Pinning BOTH the locale and the timezone makes the output a pure function of
 * the timestamp, so both sides produce the same string. Asia/Kolkata is the
 * house timezone; the usage report groups its days by it too.
 */

const ZONE = "Asia/Kolkata";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The calendar parts of a timestamp AS SEEN in the house timezone.
 *
 * Intl is used only to do the timezone arithmetic, never to choose words:
 * asking it for `month: "short"` returns whatever the runtime's ICU has, which
 * is "Sept" for September under en-GB and "Sep" under en-US. Two formatters
 * disagreeing on a month name is the same class of inconsistency this module
 * exists to remove — so the month name always comes from MONTHS below.
 */
function zonedParts(d: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** "17 Aug 2026" — unambiguous, and the same on every machine. */
export function formatDate(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const p = zonedParts(d);
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${p.year}`;
}

/** "17 Aug 2026, 14:30". */
export function formatDateTime(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const p = zonedParts(d);
  // Midnight comes back as "24" from some ICU builds under hour12:false.
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${hour}:${p.minute}`;
}

/**
 * "21 Sep 2026" from a plain YYYY-MM-DD.
 *
 * Read off the parts rather than through Date on purpose: a calendar date has
 * no time and no zone, and `new Date("2026-08-17T00:00:00")` parses in the
 * runtime's LOCAL zone — so a browser west of UTC would shift it to the 16th
 * while the server kept the 17th. Formatting the digits avoids the question.
 */
export function formatYmd(ymd: string): string {
  const [y, m, d] = String(ymd).split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return String(ymd);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "17 Aug" — {@link formatYmd} without the year, for dense tables and axes. */
export function formatDayMonth(ymd: string): string {
  const [, m, d] = String(ymd).split("-").map(Number);
  if (!m || !d || m < 1 || m > 12) return String(ymd);
  return `${d} ${MONTHS[m - 1]}`;
}
