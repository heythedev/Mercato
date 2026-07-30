"use client";

import Lottie from "lottie-react";
import cosmos from "../../../public/Cosmos.json";
import { cn } from "@/lib/utils";

/**
 * Cosmos Lottie animation used as an in-app loading indicator.
 *
 * The artwork is pure black. By default it renders black on light surfaces and
 * inverts to white in dark mode. Pass `onDark` when it sits on a surface that is
 * dark in light mode and light in dark mode (e.g. a primary-colored button), so
 * the inversion is flipped to stay contrasting.
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
  return (
    <Lottie
      animationData={cosmos}
      loop
      autoplay
      className={cn(onDark ? "invert dark:invert-0" : "dark:invert", className)}
      style={{ width: size, height: size }}
    />
  );
}
