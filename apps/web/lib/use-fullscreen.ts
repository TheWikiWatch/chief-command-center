"use client";

import { useEffect, useSyncExternalStore } from "react";

import { layerDepth } from "@/lib/overlay-stack";

/**
 * Page full screen (PLAN-2026-09-26 Phase 1). State always comes from the document, never a local
 * guess, so Esc, F11 and the button stay in step. iPhone Safari has no element full screen, so
 * `supported` is false there and the controls do not render.
 */
export type FullscreenState = {
  supported: boolean;
  /** The page is full screen through the Fullscreen API (the button can exit it). */
  active: boolean;
  /** The browser itself is full screen (F11); script cannot exit that, so the button explains. */
  browser: boolean;
};

type WebkitDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void> | void };

const OFF: FullscreenState = { supported: false, active: false, browser: false };
const BROWSER_QUERY = "(display-mode: fullscreen)";
let snapshot: FullscreenState = OFF;

function read(): FullscreenState {
  if (typeof document === "undefined") return OFF;
  const doc = document as WebkitDocument;
  const supported = !!(doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled);
  const active = !!(doc.fullscreenElement ?? doc.webkitFullscreenElement);
  let browser = false;
  try {
    browser = !active && typeof window.matchMedia === "function" && window.matchMedia(BROWSER_QUERY).matches;
  } catch {
    browser = false;
  }
  const next = { supported, active, browser };
  if (next.supported !== snapshot.supported || next.active !== snapshot.active || next.browser !== snapshot.browser) snapshot = next;
  return snapshot;
}

function subscribe(onChange: () => void) {
  if (typeof document === "undefined") return () => undefined;
  const sync = () => {
    read();
    onChange();
  };
  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("webkitfullscreenchange", sync);
  // F11 flips display-mode; some browsers only report it through a resize.
  const mq = typeof window.matchMedia === "function" ? window.matchMedia(BROWSER_QUERY) : null;
  mq?.addEventListener?.("change", sync);
  window.addEventListener("resize", sync);
  return () => {
    document.removeEventListener("fullscreenchange", sync);
    document.removeEventListener("webkitfullscreenchange", sync);
    mq?.removeEventListener?.("change", sync);
    window.removeEventListener("resize", sync);
  };
}

export function useFullscreen(): FullscreenState {
  return useSyncExternalStore(subscribe, read, () => OFF);
}

/** Enter or leave page full screen. Resolves false when the browser refused (no gesture, policy). */
export async function toggleFullscreen(): Promise<boolean> {
  const doc = document as WebkitDocument;
  try {
    if (doc.fullscreenElement ?? doc.webkitFullscreenElement) {
      await (doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.());
      return true;
    }
    const root = document.documentElement as WebkitElement;
    if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: "hide" });
    else if (root.webkitRequestFullscreen) await root.webkitRequestFullscreen();
    else return false;
    return true;
  } catch {
    return false;
  }
}

function typing(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return !!el.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

/** Whether a key event should toggle full screen: plain F, not typing, no sheet open. */
export function isFullscreenKey(e: KeyboardEvent) {
  if (e.key !== "f" && e.key !== "F") return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || e.isComposing) return false;
  if (typing(e.target)) return false;
  return layerDepth() === 0;
}

/** Desktop shortcut: F toggles page full screen (Esc exits natively). */
export function useFullscreenShortcut(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isFullscreenKey(e) || !read().supported || read().browser) return;
      e.preventDefault();
      void toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
