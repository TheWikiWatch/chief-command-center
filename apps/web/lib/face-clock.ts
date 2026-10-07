"use client";

import { useEffect, useRef } from "react";

import { motionReducedNow } from "@/lib/motion";

/**
 * One requestAnimationFrame loop for every face on screen (VISUAL-OVERHAUL §4.1).
 * Faces register an updater that writes transforms/attributes straight to the DOM,
 * so animation never causes a React render. The loop stops when nothing is visible,
 * the page is hidden, or motion is reduced; on coarse-pointer devices it runs at 30fps, and at 60 while a face on
 * screen is busy (thinking, working, speaking): its motion is the one being watched, and 30fps makes it read as jerky.
 * Each frame runs every `measure` (layout reads) before any `update` (DOM writes), so faces
 * that need their screen position cost one layout per frame, not one per face.
 */
export type FaceUpdater = (t: number) => void;
export type FaceMeasurer = () => void;

type Entry = { update: FaceUpdater; measure?: FaceMeasurer; visible: boolean; busy?: () => boolean };

const entries = new Set<Entry>();
let raf = 0;
let origin = 0;
let last = 0;
let wired = false;

function frameBudget() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return 0;
  if (!window.matchMedia("(pointer: coarse)").matches) return 0;
  for (const e of entries) if (e.visible && e.busy?.()) return 0;
  return 33;
}

/** The clock's current time (seconds), the same `t` the next frame gets: for drawing a pose outside the loop. */
export function clockTime(): number {
  wire();
  return typeof performance === "undefined" ? 0 : (performance.now() - origin) / 1000;
}

function loop(now: number) {
  raf = 0;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  schedule();
  const budget = frameBudget();
  if (budget && now - last < budget) return;
  last = now;
  const t = (now - origin) / 1000;
  for (const entry of entries) {
    if (!entry.visible || !entry.measure) continue;
    try {
      entry.measure();
    } catch {
      /* a face that fails to measure draws without its position */
    }
  }
  for (const entry of entries) {
    if (!entry.visible) continue;
    try {
      entry.update(t);
    } catch {
      /* a face that fails to draw should not stop the others */
    }
  }
}

function schedule() {
  if (raf || typeof window === "undefined" || typeof requestAnimationFrame !== "function") return;
  if (!entries.size || motionReducedNow()) return;
  if (![...entries].some((e) => e.visible)) return;
  raf = requestAnimationFrame(loop);
}

function wire() {
  if (wired || typeof document === "undefined") return;
  wired = true;
  origin = performance.now();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") schedule();
  });
}

/** Number of registered faces (tests, and the roster-churn leak check). */
export function faceCount() {
  return entries.size;
}

/** Draw every visible face once at time t (tests and reduced-motion static poses). */
export function drawFaces(t: number) {
  for (const entry of entries) entry.measure?.();
  for (const entry of entries) entry.update(t);
}

/**
 * Register a face. `update` runs every frame while `el` is on screen.
 * With reduced motion it runs once so the face shows a correct static pose.
 */
export function useFaceClock(el: React.RefObject<Element | null>, update: FaceUpdater, enabled = true, measure?: FaceMeasurer, busy?: () => boolean) {
  // The newest callbacks, read by the loop (one ref, so a re-render never re-registers the face).
  const latest = useRef({ update, measure, busy });
  latest.current = { update, measure, busy };
  const measures = !!measure;
  useEffect(() => {
    if (!enabled) return;
    wire();
    const entry: Entry = {
      update: (t) => latest.current.update(t),
      measure: measures ? () => latest.current.measure?.() : undefined,
      visible: true,
      busy: () => !!latest.current.busy?.(),
    };
    entries.add(entry);
    const node = el.current;
    let io: IntersectionObserver | undefined;
    if (node && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((records) => {
        entry.visible = records.some((r) => r.isIntersecting);
        if (entry.visible) schedule();
      });
      io.observe(node);
    }
    entry.update(0);
    schedule();
    return () => {
      io?.disconnect();
      entries.delete(entry);
      if (!entries.size && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
  }, [el, enabled, measures]);
}

/** Wake the loop after a state change (a face that was idle may need to animate again). */
export function kickFaceClock() {
  schedule();
}
