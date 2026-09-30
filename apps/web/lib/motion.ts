"use client";

import { useSyncExternalStore } from "react";

import { useFxPrefs } from "@/lib/fx-prefs";

/** Motion tokens (VISUAL-OVERHAUL §3.1). CSS mirrors these as --dur-* and --ease-*. */
export const DUR = { press: 0.08, fast: 0.14, base: 0.22, medium: 0.32, sheet: 0.48 } as const;

export const EASE = {
  enter: [0.22, 1, 0.36, 1],
  exit: [0.3, 0, 0.8, 0.15],
  move: [0.65, 0, 0.35, 1],
  sheet: [0.32, 0.72, 0, 1],
} as const satisfies Record<string, [number, number, number, number]>;

export const SPRING = {
  snappy: { type: "spring", duration: 0.3, bounce: 0.15 },
  bouncy: { type: "spring", duration: 0.45, bounce: 0.3 },
  gentle: { type: "spring", duration: 0.6, bounce: 0 },
} as const;

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribeOs(onChange: () => void) {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function osReduced() {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/** True when motion should be reduced: the in-app setting wins, otherwise the OS setting. */
export function useReducedMotion(): boolean {
  const prefs = useFxPrefs();
  const os = useSyncExternalStore(subscribeOs, osReduced, () => false);
  if (prefs.motion === "full") return false;
  if (prefs.motion === "reduced") return true;
  return os;
}

/** Non-hook check for animation loops that run outside React. */
export function motionReducedNow(): boolean {
  if (typeof document === "undefined") return false;
  const pref = document.documentElement.dataset.motion;
  if (pref === "full") return false;
  if (pref === "reduced") return true;
  return osReduced();
}
