/**
 * Resource-conscious polling for long-running background jobs.
 *
 * Verify and categorize runs can last 15+ minutes on a large catalog, and the UI
 * polls a progress feed throughout. A naive `setInterval(poll, 2000)` has three
 * problems that add up to real CPU, battery and server load while the user is
 * trying to work in another app:
 *
 *  1. It keeps polling at full rate when the tab is hidden — hundreds of
 *     needless requests, each running database queries, for updates nobody can
 *     see. (Browsers clamp background timers to ~1/minute, but that still fires,
 *     and a *visible but unfocused* window isn't clamped at all.)
 *  2. It can overlap: if one poll takes longer than the interval, the next fires
 *     anyway and they pile up.
 *  3. It polls at the same rate whether or not anything is changing.
 *
 * `startPolling` fixes all three:
 *  - Pauses entirely while the tab is hidden, and polls once immediately on
 *    return so the UI catches up instantly.
 *  - Self-scheduling (setTimeout after completion, not setInterval), so polls
 *    can never overlap or stack up.
 *  - Backs off gradually when a poll reports "nothing new", down to a slower
 *    idle rate, and snaps back to the fast rate the moment something changes.
 */

export type PollScheduler = {
  /** Stop polling and release all listeners/timers. Safe to call more than once. */
  stop: () => void;
};

export type StartPollingOptions = {
  /**
   * One poll. Return `true` when it produced new data (keeps the fast cadence),
   * `false` when nothing changed (allows backing off). Throwing is treated as
   * "nothing changed" — transient failures shouldn't stop the loop.
   */
  poll: () => Promise<boolean>;
  /** Cadence while data is actively arriving. */
  activeMs?: number;
  /** Slowest cadence once repeatedly idle. */
  idleMs?: number;
};

/**
 * Sleep between iterations of a job-status polling loop, stretching the wait
 * while the tab is hidden.
 *
 * Unlike the progress feeds, these loops must keep running in the background —
 * they're what notices the job finished. But there's no reason to check every
 * couple of seconds when nobody is looking: a completion the user can't see is
 * equally useful noticed a few seconds later. Polling slower while hidden cuts
 * background requests by ~4× with no perceptible difference, and the wait is cut
 * short the moment the tab becomes visible again.
 */
export function sleepForPoll(visibleMs: number, hiddenMs = visibleMs * 4): Promise<void> {
  const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
  const ms = hidden ? hiddenMs : visibleMs;

  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
      resolve();
    };
    // Coming back to the tab shouldn't leave the user waiting out a long
    // background sleep — wake immediately and refresh.
    const onVisible = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") finish();
    };
    const timer = setTimeout(finish, ms);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
  });
}

export function startPolling({
  poll,
  activeMs = 2000,
  idleMs = 10000,
}: StartPollingOptions): PollScheduler {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let delay = activeMs;

  const clearTimer = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = (ms: number) => {
    clearTimer();
    if (cancelled || isHidden()) return;
    timer = setTimeout(tick, ms);
  };

  const isHidden = () =>
    typeof document !== "undefined" && document.visibilityState === "hidden";

  const tick = async () => {
    // Guard against a stray timer firing after stop(), or re-entry if a very slow
    // poll is still in flight.
    if (cancelled || running) return;
    if (isHidden()) return; // visibilitychange will resume us

    running = true;
    let gotData = false;
    try {
      gotData = await poll();
    } catch {
      // Transient failure: the job continues server-side and the next tick picks
      // up whatever landed meanwhile.
    } finally {
      running = false;
    }

    if (cancelled) return;
    // Fast while data flows; ease off (×1.5, capped) when idle so a long quiet
    // stretch doesn't hammer the server or wake the CPU every 2 seconds.
    delay = gotData ? activeMs : Math.min(Math.round(delay * 1.5), idleMs);
    schedule(delay);
  };

  const onVisibilityChange = () => {
    if (cancelled) return;
    if (isHidden()) {
      // Nothing to render for — stop completely rather than run throttled.
      clearTimer();
    } else {
      // Back on screen: poll right away so the UI is current, then resume.
      delay = activeMs;
      void tick();
    }
  };

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  // Kick off immediately so the first results appear without waiting a full tick.
  void tick();

  return {
    stop: () => {
      cancelled = true;
      clearTimer();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    },
  };
}
