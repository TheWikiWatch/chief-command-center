"use client";

import { useSyncExternalStore } from "react";

import { PREFS_EVENT } from "@/lib/dashboard-prefs";

/** Sound, haptic, motion, ambient and size preferences (VISUAL-OVERHAUL §6). One localStorage key. */
export const FX_KEY = "chief-fx";

export const FX_EVENTS = ["tap", "send", "reply", "approval", "followup", "voice", "confirm", "error", "connection", "fleet"] as const;
export type FxEvent = (typeof FX_EVENTS)[number];

export const FX_EVENT_LABELS: Record<FxEvent, string> = {
  tap: "Button taps",
  send: "Message sent",
  // {name} is the chief's display name (lib/identity).
  reply: "{name} replies",
  approval: "Approval needed",
  followup: "Follow-up nudges",
  voice: "Hold to talk",
  confirm: "Always-allow confirmed",
  error: "Errors",
  connection: "Connection lost or back",
  fleet: "Bots added or retired",
};

export type MotionPref = "system" | "full" | "reduced";
export type AmbientPref = "full" | "low" | "off";
export type UiScale = "compact" | "default" | "large";

export type FxPrefs = {
  sound: Record<FxEvent, boolean> & { master: boolean };
  haptics: Record<FxEvent, boolean> & { master: boolean };
  volume: number;
  motion: MotionPref;
  ambient: AmbientPref;
  uiScale: UiScale;
  fleetToasts: boolean;
  /** Card when a specialist finishes and Chief has not followed up (PLAN-2026-09-23 §2). */
  nudges: boolean;
  /** Card when Chief said he would check back and has not. */
  promises: boolean;
};

export const UI_SCALE: Record<UiScale, number> = { compact: 0.94, default: 1, large: 1.08 };

function eventDefaults(): Record<FxEvent, boolean> & { master: boolean } {
  const out = { master: true } as Record<FxEvent, boolean> & { master: boolean };
  for (const event of FX_EVENTS) out[event] = event !== "tap";
  return out;
}

export const DEFAULT_FX: FxPrefs = {
  sound: eventDefaults(),
  haptics: eventDefaults(),
  volume: 0.6,
  motion: "system",
  ambient: "full",
  uiScale: "default",
  fleetToasts: true,
  nudges: true,
  promises: true,
};

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** Merge stored JSON onto defaults so new events and bad values never break the app. */
export function parseFx(raw: string | null): FxPrefs {
  let stored: Partial<FxPrefs> = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object") stored = parsed;
  } catch {
    /* fall back to defaults */
  }
  const flags = (value: unknown) => {
    const out = eventDefaults();
    if (value && typeof value === "object") {
      for (const key of ["master", ...FX_EVENTS] as const) {
        const v = (value as Record<string, unknown>)[key];
        if (typeof v === "boolean") out[key] = v;
      }
    }
    return out;
  };
  const volume = typeof stored.volume === "number" && Number.isFinite(stored.volume) ? Math.min(1, Math.max(0, stored.volume)) : DEFAULT_FX.volume;
  return {
    sound: flags(stored.sound),
    haptics: flags(stored.haptics),
    volume,
    motion: pick(stored.motion, ["system", "full", "reduced"], DEFAULT_FX.motion),
    ambient: pick(stored.ambient, ["full", "low", "off"], DEFAULT_FX.ambient),
    uiScale: pick(stored.uiScale, ["compact", "default", "large"], DEFAULT_FX.uiScale),
    fleetToasts: typeof stored.fleetToasts === "boolean" ? stored.fleetToasts : DEFAULT_FX.fleetToasts,
    nudges: typeof stored.nudges === "boolean" ? stored.nudges : DEFAULT_FX.nudges,
    promises: typeof stored.promises === "boolean" ? stored.promises : DEFAULT_FX.promises,
  };
}

let cacheRaw: string | null | undefined;
let cacheValue: FxPrefs = DEFAULT_FX;

/** Stable snapshot for useSyncExternalStore: re-parse only when the stored string changes. */
export function readFx(): FxPrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(FX_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    cacheValue = parseFx(raw);
  }
  return cacheValue;
}

export function writeFx(next: FxPrefs) {
  try {
    localStorage.setItem(FX_KEY, JSON.stringify(next));
  } catch {
    /* private mode: keep defaults */
  }
  try {
    window.dispatchEvent(new Event(PREFS_EVENT));
  } catch {
    /* ignore */
  }
}

export function updateFx(change: (current: FxPrefs) => FxPrefs) {
  writeFx(change(readFx()));
}

function subscribe(onChange: () => void) {
  window.addEventListener(PREFS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREFS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function useFxPrefs(): FxPrefs {
  return useSyncExternalStore(subscribe, readFx, () => DEFAULT_FX);
}

/** Whether a sound or haptic should fire for this event right now. */
export function fxEnabled(kind: "sound" | "haptics", event: FxEvent, prefs: FxPrefs = readFx()) {
  const group = prefs[kind];
  return group.master && group[event];
}
