import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Human-readable duration from a millisecond count.
 *   1_200      → "1.2s"
 *   65_000     → "1m 5s"
 *   3_725_000  → "1h 2m"
 * Returns null for null/undefined/non-positive input so callers can skip rendering.
 */
export function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null || ms <= 0) return null;
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = Math.round(totalSec % 60);
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}
