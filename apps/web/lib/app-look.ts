"use client";

import { useCallback, useEffect, useState } from "react";

import { requestJson, friendlyError } from "@/lib/request";

/*
 * The app's look (bridge contract `chief.app_look.v1`, app_look.py): an accent and dark, light or system mode,
 * one choice for every window and the phone. The owner picks it in Settings → General; the chief can too
 * (`set_app_look`). The last look is kept on this device as well, so a reload paints in it before the bridge
 * answers (the inline script in app/layout.tsx reads the same key).
 *
 * Accents are Hermes's swatch ids with the dashboard's own colours, "theme" (the app's red, as in globals.css),
 * or any #rrggbb. Each becomes three tokens, adjusted per mode so text in it stays readable:
 *   --c-accent        the colour itself (rings, highlights, tints)
 *   --c-accent-solid  a filled button with white text on it (>= 4.5:1 against white)
 *   --c-accent-text   accent-coloured text on the canvas (>= 4.5:1 against it)
 */

export type LookMode = "dark" | "light" | "system";
export type AppLook = { accent: string; mode: LookMode; by: string; at: number; canUndo: boolean };

export const SWATCHES: { id: string; label: string; hex: string }[] = [
  { id: "theme", label: "Chief red", hex: "#e5484d" },
  { id: "orange", label: "Orange", hex: "#f76b15" },
  { id: "green", label: "Green", hex: "#30a46c" },
  { id: "cyan", label: "Cyan", hex: "#00a2c7" },
  { id: "nous", label: "Nous blue", hex: "#3e63dd" },
  { id: "violet", label: "Violet", hex: "#8e4ec6" },
  { id: "pink", label: "Pink", hex: "#d6409f" },
  { id: "red", label: "Red", hex: "#e5484d" },
  { id: "mono", label: "Mono", hex: "#8b8b94" },
];
export const MODE_LABEL: Record<LookMode, string> = { dark: "Dark", light: "Light", system: "System" };

export const LOOK_KEY = "chief-app-look";
export const LOOK_EVENT = "chief:app-look";
const DEFAULT: AppLook = { accent: "theme", mode: "dark", by: "owner", at: 0, canUndo: false };
const HEX = /^#[0-9a-f]{6}$/i;

type RGB = [number, number, number];

function hexRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance([r, g, b]: RGB): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: RGB, b: RGB): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;

/** Move `color` toward `to` in small steps until it reaches `ratio` against `against` (or as far as it can). */
function until(color: RGB, to: RGB, against: RGB, ratio: number): RGB {
  for (let t = 0; t <= 1.0001; t += 0.04) {
    const next = mix(color, to, t);
    if (contrast(next, against) >= ratio) return next;
  }
  return to;
}

const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];
const CANVAS: Record<"dark" | "light", RGB> = { dark: [9, 9, 11], light: [255, 255, 255] };

/** The accent's hex: a swatch's colour, or the owner's own #rrggbb; anything else is the theme's. */
export function accentHex(accent: string): string {
  if (HEX.test(accent)) return accent.toLowerCase();
  return (SWATCHES.find((s) => s.id === accent) || SWATCHES[0]).hex;
}

/** The three accent tokens ("r g b") for a mode; null for the theme's own (globals.css already has them). */
export function accentTokens(accent: string, mode: "dark" | "light"): Record<string, string> | null {
  if (accent === "theme" || (!HEX.test(accent) && !SWATCHES.some((s) => s.id === accent))) return null;
  const base = hexRgb(accentHex(accent));
  const solid = until(base, BLACK, WHITE, 4.5);
  const text = mode === "dark" ? until(base, WHITE, CANVAS.dark, 4.5) : until(base, BLACK, CANVAS.light, 4.5);
  const triplet = (c: RGB) => c.join(" ");
  return { "--c-accent": triplet(base), "--c-accent-solid": triplet(solid), "--c-accent-text": triplet(text) };
}

export function resolvedMode(mode: LookMode): "dark" | "light" {
  if (mode !== "system") return mode;
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export const CANVAS_HEX: Record<"dark" | "light", string> = { dark: "#09090B", light: "#F6F6F8" };

/** Put a look on the page: the mode attribute, the accent tokens, the browser's theme colour, and this device's copy. */
export function applyLook(look: Pick<AppLook, "accent" | "mode">) {
  const root = document.documentElement;
  const mode = resolvedMode(look.mode);
  if (mode === "light") root.dataset.theme = "light";
  else delete root.dataset.theme;
  for (const name of ["--c-accent", "--c-accent-solid", "--c-accent-text"]) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(accentTokens(look.accent, mode) || {})) root.style.setProperty(name, value);
  root.style.setProperty("--boot-bg", CANVAS_HEX[mode]);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", CANVAS_HEX[mode]);
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify({ accent: look.accent, mode: look.mode, tokens: accentTokens(look.accent, mode) }));
  } catch {
    // a private window: the next reload paints in the default, then the bridge's look
  }
  // The desktop app follows the mode (its title bar, and "system" there).
  (window as unknown as { chiefDesktop?: { setThemeMode?: (mode: LookMode) => void } }).chiefDesktop?.setThemeMode?.(look.mode);
}

const api = {
  get: () => requestJson<AppLook & { ok: boolean; error?: string }>("/api/bridge/app-look", { cache: "no-store" }, 10_000),
  post: (body: Record<string, unknown>) =>
    requestJson<AppLook & { ok: boolean; error?: string }>(
      "/api/bridge/app-look",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      10_000,
    ),
};

function cached(): AppLook {
  try {
    const raw = JSON.parse(localStorage.getItem(LOOK_KEY) || "{}");
    if (raw && typeof raw.accent === "string" && ["dark", "light", "system"].includes(raw.mode)) return { ...DEFAULT, accent: raw.accent, mode: raw.mode };
  } catch {
    // fall through
  }
  return DEFAULT;
}

/**
 * The look, applied to the page and kept current: read from the bridge on mount, again whenever the bridge says
 * it changed (lib/live.ts raises LOOK_EVENT), and when the device's own light/dark changes while in "system".
 */
export function useAppLook() {
  const [look, setLook] = useState<AppLook>(() => (typeof window === "undefined" ? DEFAULT : cached()));
  const [error, setError] = useState("");

  const take = useCallback((next: AppLook & { ok?: boolean; error?: string }) => {
    if (next.ok === false) throw new Error(next.error || "That didn't save.");
    const clean: AppLook = { accent: next.accent, mode: next.mode, by: next.by, at: next.at, canUndo: next.canUndo };
    setLook(clean);
    applyLook(clean);
    return clean;
  }, []);

  useEffect(() => {
    applyLook(cached());
    const load = () => void api.get().then(take).catch(() => undefined);
    load();
    window.addEventListener(LOOK_EVENT, load);
    return () => window.removeEventListener(LOOK_EVENT, load);
  }, [take]);

  useEffect(() => {
    if (look.mode !== "system") return undefined;
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    const follow = () => applyLook(look);
    media?.addEventListener("change", follow);
    return () => media?.removeEventListener("change", follow);
  }, [look]);

  const change = useCallback(
    async (body: Record<string, unknown>) => {
      setError("");
      try {
        return take(await api.post(body));
      } catch (e) {
        setError(friendlyError(e, "That didn't save."));
        return null;
      }
    },
    [take],
  );

  return {
    look,
    error,
    setAccent: (accent: string) => change({ accent }),
    setMode: (mode: LookMode) => change({ mode }),
    undo: () => change({ undo: true }),
    reset: () => change({ reset: true }),
  };
}

/** For app/layout.tsx: runs before the first paint, from this device's copy of the last look. */
export const BOOT_SCRIPT = `(function(){try{var l=JSON.parse(localStorage.getItem(${JSON.stringify(LOOK_KEY)})||"{}");var r=document.documentElement;var m=l.mode==="system"?(matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):l.mode;if(m==="light"){r.dataset.theme="light";r.style.setProperty("--boot-bg","${CANVAS_HEX.light}")}var t=l.tokens||{};for(var k in t){if(/^--c-accent(-solid|-text)?$/.test(k)&&/^\\d{1,3} \\d{1,3} \\d{1,3}$/.test(t[k]))r.style.setProperty(k,t[k])}}catch(e){}})();`;
