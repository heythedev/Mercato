"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * Motion primitives, and the switch that turns them all off.
 *
 * Nothing in the app respected `prefers-reduced-motion` before this — 21
 * spinners, 4 pulses and 38 transitions, none of them asking. For someone with
 * vestibular sensitivity that is not a rough edge, it is a reason to stop using
 * the software. So the hook comes first and everything below consults it.
 *
 * The rule in globals.css handles CSS transitions wholesale; these exist for
 * the JavaScript-driven motion CSS cannot reach — a number counting up, a
 * sparkline advancing — which would otherwise keep moving after the user has
 * asked it not to.
 */

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * useSyncExternalStore rather than useEffect + useState: it reads the value
 * during render with no flash of the wrong behaviour, and the server snapshot
 * is `false` so markup matches on hydration.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    useCallback((notify: () => void) => {
      const mq = window.matchMedia(QUERY);
      mq.addEventListener("change", notify);
      return () => mq.removeEventListener("change", notify);
    }, []),
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

/**
 * A number that travels to its new value instead of jumping.
 *
 * The point is not decoration. During a categorise run this figure changes
 * every few seconds, and a number that snaps reads as a page that reloaded —
 * you cannot tell a live screen from a stale one. Travelling says "this is
 * moving" without a spinner claiming it.
 *
 * Ease-out cubic: fast at the start so the change registers immediately, slow
 * at the end so the final value is readable rather than arriving mid-blur.
 */
export function CountUp({
  value,
  duration = 400,
  format = (n: number) => n.toLocaleString(),
}: {
  value: number;
  duration?: number;
  format?: (n: number) => string;
}) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(value);

  // What is actually on screen right now. The animation always starts HERE,
  // never from a remembered target — that distinction is the whole bug this
  // replaced. The old version kept a `from` ref and reset it to the target on
  // cleanup, so when the value changed faster than the animation finished,
  // successive runs chased a figure that was never displayed and overlapping
  // frame loops compounded it. Rendered as "-11,411,393 of 1,999 products",
  // which is how it was caught: by looking at it.
  // Written only inside the effect and the frame callback, never during
  // render — the React Compiler rightly refuses that, and it would also be a
  // lie under concurrent rendering, where a render can be thrown away.
  const shownRef = useRef(value);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const from = shownRef.current;
    if (reduced || from === value || !Number.isFinite(value)) {
      shownRef.current = value;
      setShown((s) => (s === value ? s : value));
      return;
    }
    // Exactly one loop at a time: a value arriving mid-flight cancels the
    // previous frame before scheduling its own.
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);

    const startedAt = performance.now();
    const lo = Math.min(from, value);
    const hi = Math.max(from, value);
    const step = (now: number) => {
      const raw = Math.min(1, Math.max(0, (now - startedAt) / duration));
      const eased = 1 - Math.pow(1 - raw, 3);
      // Clamped to the interval being travelled. Belt and braces: a clock that
      // jumps — a background tab, or Chrome's virtual time under a headless
      // screenshot — must never put a figure outside its own endpoints.
      const next = Math.min(hi, Math.max(lo, Math.round(from + (value - from) * eased)));
      shownRef.current = next;
      setShown(next);
      frameRef.current = raw < 1 ? requestAnimationFrame(step) : null;
    };
    frameRef.current = requestAnimationFrame(step);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [value, duration, reduced]);

  return <>{format(shown)}</>;
}

/**
 * Throughput over the last few minutes, as a bar per sample.
 *
 * This is the part that changes how a long run feels. A progress bar says work
 * is happening; a rate line says whether it is HEALTHY. When throughput
 * collapses to zero the bar keeps sitting there looking patient, and this goes
 * flat — which is the difference between noticing a stall now and noticing it
 * twenty minutes later.
 */
export function Sparkline({
  values,
  className,
  label,
}: {
  values: number[];
  className?: string;
  label?: string;
}) {
  const peak = Math.max(...values, 1);
  return (
    <span
      className={["flex h-5 items-end gap-[3px]", className].filter(Boolean).join(" ")}
      role="img"
      aria-label={label ?? `Throughput, most recent ${values.length} samples`}
    >
      {values.map((v, i) => (
        <span
          key={i}
          // 4px with a 3px gap. At 3/2 the bars merged into a grey block and
          // stopped reading as a series at all — which defeats the one thing
          // this is for.
          className="w-1 rounded-[1px] bg-foreground/25 transition-[height] duration-300 ease-out"
          style={{ height: `${Math.max(8, (v / peak) * 100)}%` }}
        />
      ))}
    </span>
  );
}
