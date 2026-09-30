"use client";

import { MotionConfig } from "motion/react";
import { useEffect, type ReactNode } from "react";

import { fx, unlockFx } from "@/lib/fx";
import { UI_SCALE, useFxPrefs } from "@/lib/fx-prefs";
import { useReducedMotion } from "@/lib/motion";

/** Applies motion, ambient and interface-size preferences to the whole document. */
export function FxRoot({ children }: { children: ReactNode }) {
  const prefs = useFxPrefs();
  const reduced = useReducedMotion();

  useEffect(() => {
    const root = document.documentElement;
    if (prefs.motion === "system") delete root.dataset.motion;
    else root.dataset.motion = prefs.motion;
    root.dataset.ambient = prefs.ambient;
    root.style.setProperty("--ui-scale", String(UI_SCALE[prefs.uiScale]));
  }, [prefs.motion, prefs.ambient, prefs.uiScale]);

  // Audio may only start after a gesture; taps get their (default off) tick and haptic.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      unlockFx();
      if ((e.target as Element | null)?.closest?.("button, a[href], [role='tab'], [role='menuitem']")) fx("tap");
    };
    const onKey = () => unlockFx();
    document.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return <MotionConfig reducedMotion={reduced ? "always" : "never"}>{children}</MotionConfig>;
}
