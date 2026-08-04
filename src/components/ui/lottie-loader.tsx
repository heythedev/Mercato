"use client";

import Lottie, { type LottieRefCurrentProps } from "lottie-react";
import { useEffect, useRef } from "react";
import cosmos from "../../../public/Cosmos.json";
import { cn } from "@/lib/utils";

/**
 * Cosmos Lottie animation used as an in-app loading indicator.
 *
 * The artwork is pure black. By default it renders black on light surfaces and
 * inverts to white in dark mode. Pass `onDark` when it sits on a surface that is
 * dark in light mode and light in dark mode (e.g. a primary-colored button), so
 * the inversion is flipped to stay contrasting.
 *
 * ── Resource behaviour ──────────────────────────────────────────────────────
 * This is a 60fps animation that can be on screen for the entire length of a
 * multi-minute verify/categorize run. Left unmanaged it repaints 60×/second
 * indefinitely — noticeable CPU and battery drain while the user works in
 * another app. Two guards keep it cheap:
 *
 *  1. Paused whenever the tab is hidden. Browsers throttle rAF in background
 *     tabs but don't stop lottie-web's work reliably, and a visible-but-
 *     unfocused window isn't throttled at all. Pausing releases the work
 *     entirely and resumes seamlessly when the user comes back.
 *  2. Honours `prefers-reduced-motion`: holds a static frame instead of
 *     animating, for users who've asked the OS to limit animation.
 */
export function LottieLoader({
  className,
  size = 96,
  onDark = false,
}: {
  className?: string;
  size?: number;
  onDark?: boolean;
}) {
  const lottieRef = useRef<LottieRefCurrentProps | null>(null);

  useEffect(() => {
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

    const sync = () => {
      const api = lottieRef.current;
      if (!api) return;
      // Pause when hidden, or when the user prefers reduced motion; otherwise run.
      if (document.visibilityState === "hidden" || motionQuery.matches) api.pause();
      else api.play();
    };

    sync();
    motionQuery.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      motionQuery.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return (
    <Lottie
      lottieRef={lottieRef}
      animationData={cosmos}
      loop
      autoplay
      className={cn(onDark ? "invert dark:invert-0" : "dark:invert", className)}
      style={{ width: size, height: size }}
    />
  );
}
