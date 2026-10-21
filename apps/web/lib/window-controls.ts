"use client";

import { useEffect } from "react";

/*
 * The desktop app draws Windows' minimize, maximize and close over the page's top-right corner (Window Controls
 * Overlay, apps/desktop/src/window.ts). Headers reaching that corner keep clear of them with `--wco` (globals.css),
 * which starts from Chromium's `env(titlebar-area-*)`. Those values alone weren't enough: after a resize, a
 * maximize, a snap or a zoom change they could lag or be missing, and the header's gear slid under the minimize
 * button. So the page measures the overlay itself (`navigator.windowControlsOverlay`), again on each geometry change
 * and resize, and in the desktop app never reserves less than the three caption buttons take.
 */

// Windows 11's caption buttons are 46 device-independent pixels each; CSS pixels match them at 100% page zoom.
export const CAPTION_BUTTONS_PX = 3 * 46;
// Breathing room between the last header button and minimize.
export const CAPTION_GAP_PX = 8;

type Overlay = {
  visible: boolean;
  getTitlebarAreaRect: () => DOMRect;
  addEventListener: (type: "geometrychange", fn: () => void) => void;
  removeEventListener: (type: "geometrychange", fn: () => void) => void;
};

/** The width the window buttons take from the right edge, in CSS pixels (0 where there are none). */
export function controlsWidth(viewportWidth: number, overlay: Overlay | null | undefined, inDesktop: boolean): number {
  let measured = 0;
  if (overlay?.visible) {
    const rect = overlay.getTitlebarAreaRect();
    if (rect && rect.width > 0) measured = Math.max(0, viewportWidth - (rect.x + rect.width));
  }
  if (!inDesktop && !overlay?.visible) return 0;
  // A page zoom changes how many CSS pixels the buttons cover; the overlay's own measurement follows that.
  return Math.max(measured, CAPTION_BUTTONS_PX) + CAPTION_GAP_PX;
}

/** Keeps `--wco` on <html> equal to the window buttons' width (desktop app only; a browser keeps 0). */
export function useWindowControlsGap() {
  useEffect(() => {
    const nav = navigator as Navigator & { windowControlsOverlay?: Overlay };
    const overlay = nav.windowControlsOverlay;
    const inDesktop = !!(window as unknown as { chiefDesktop?: unknown }).chiefDesktop && /Windows/i.test(navigator.userAgent);
    if (!overlay && !inDesktop) return undefined;
    const root = document.documentElement;
    const apply = () => root.style.setProperty("--wco", `${controlsWidth(window.innerWidth, overlay, inDesktop)}px`);
    apply();
    overlay?.addEventListener("geometrychange", apply);
    window.addEventListener("resize", apply);
    return () => {
      overlay?.removeEventListener("geometrychange", apply);
      window.removeEventListener("resize", apply);
      root.style.removeProperty("--wco");
    };
  }, []);
}
