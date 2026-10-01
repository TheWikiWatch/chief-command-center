"use client";

/**
 * Android Chrome offers to install a web app with `beforeinstallprompt`, which fires once, early, and only if
 * the page listens before it happens. This module listens as soon as it loads (command-shell imports it), and
 * Settings → Phone shows a real "Install app" button with it. iPhone has no such event: the page shows the
 * Share → Add to Home Screen steps instead.
 */
type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

let deferred: InstallEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    notify();
  });
}

export function canPromptInstall(): boolean {
  return !!deferred;
}

export function onInstallPromptChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Show Chrome's install dialog; true when the owner installed. */
export async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  deferred = null;
  notify();
  await e.prompt();
  return (await e.userChoice).outcome === "accepted";
}

/** Opened from the home screen (or as an installed app). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export type PhonePlatform = "ios" | "android" | "other";

export function phonePlatform(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): PhonePlatform {
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}
