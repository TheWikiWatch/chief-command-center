"use client";

import { fxEnabled, readFx, type FxEvent } from "@/lib/fx-prefs";
import { getSpeaking } from "@/lib/voice-client";

/**
 * Interface sounds and haptics (VISUAL-OVERHAUL §6). Every sound is synthesized with Web Audio at
 * play time: no files, no network. Each event is gated by its own sound and haptic switch, plays
 * only while the page is visible, and ducks to half volume while the chief is speaking.
 */
export type FxVariant = "start" | "stop" | "cancel" | "lost" | "back" | "minted" | "retired";

const HAPTICS: Record<string, number | number[]> = {
  tap: 6,
  send: 12,
  reply: [8, 40, 8],
  approval: [20, 60, 20, 60, 40],
  followup: [15, 50, 15],
  "voice:start": 15,
  "voice:stop": 10,
  "voice:cancel": 10,
  confirm: 30,
  error: [30, 40, 30],
  "connection:lost": 20,
  "connection:back": [10, 30, 10],
  "fleet:minted": [10, 30, 20],
  "fleet:retired": 15,
};

let ctx: AudioContext | null = null;
let unlocked = false;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    return ctx;
  } catch {
    return null;
  }
}

/** Call once from a user gesture so later sounds are allowed to play. */
export function unlockFx() {
  if (unlocked) return;
  unlocked = true;
  audio();
}

type Note = { f: number; t: number; d: number; type?: OscillatorType; to?: number; g?: number; fm?: number };

function play(notes: Note[], master: number): boolean {
  const ac = audio();
  if (!ac || ac.state !== "running") return false;
  const out = ac.createGain();
  out.gain.value = master;
  out.connect(ac.destination);
  const now = ac.currentTime + 0.01;
  for (const n of notes) {
    const start = now + n.t;
    const osc = ac.createOscillator();
    const env = ac.createGain();
    osc.type = n.type || "sine";
    osc.frequency.setValueAtTime(n.f, start);
    if (n.to) osc.frequency.exponentialRampToValueAtTime(n.to, start + n.d);
    if (n.fm) {
      // Soft FM for marimba-like tones.
      const mod = ac.createOscillator();
      const depth = ac.createGain();
      mod.frequency.value = n.f * n.fm;
      depth.gain.setValueAtTime(n.f * 1.4, start);
      depth.gain.exponentialRampToValueAtTime(1, start + n.d);
      mod.connect(depth).connect(osc.frequency);
      mod.start(start);
      mod.stop(start + n.d + 0.05);
    }
    const peak = n.g ?? 0.3;
    env.gain.setValueAtTime(0.0001, start);
    env.gain.exponentialRampToValueAtTime(peak, start + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, start + n.d);
    osc.connect(env).connect(out);
    osc.start(start);
    osc.stop(start + n.d + 0.05);
  }
  setTimeout(() => out.disconnect(), 1500);
  return true;
}

function recipe(event: FxEvent, variant?: FxVariant): Note[] {
  switch (event) {
    case "tap":
      return [{ f: 2000, t: 0, d: 0.012, g: 0.08 }];
    case "send":
      return [{ f: 1200, t: 0, d: 0.05, g: 0.22 }, { f: 1800, t: 0.012, d: 0.035, g: 0.08 }];
    case "reply":
      return [
        { f: 660, t: 0, d: 0.18, fm: 3.5, g: 0.2 },
        { f: 880, t: 0.09, d: 0.22, fm: 3.5, g: 0.2 },
      ];
    case "approval":
      return [
        { f: 523.25, t: 0, d: 0.32, type: "triangle", g: 0.2 },
        { f: 659.25, t: 0.11, d: 0.32, type: "triangle", g: 0.2 },
        { f: 783.99, t: 0.22, d: 0.42, type: "triangle", g: 0.22 },
      ];
    case "followup":
      // A gentle two-note nudge, lower and softer than the approval chime.
      return [
        { f: 587.33, t: 0, d: 0.22, type: "triangle", g: 0.16 },
        { f: 880, t: 0.14, d: 0.3, type: "triangle", g: 0.14 },
      ];
    case "voice":
      return variant === "stop" ? [{ f: 440, t: 0, d: 0.03, g: 0.16 }] : variant === "cancel" ? [] : [{ f: 220, t: 0, d: 0.035, g: 0.2 }];
    case "confirm":
      return [
        { f: 1568, t: 0, d: 0.2, g: 0.14 },
        { f: 2093, t: 0.02, d: 0.24, g: 0.08 },
      ];
    case "error":
      return [
        { f: 330, t: 0, d: 0.1, type: "triangle", g: 0.18 },
        { f: 247, t: 0.12, d: 0.16, type: "triangle", g: 0.18 },
      ];
    case "connection":
      return variant === "back" ? [{ f: 440, to: 660, t: 0, d: 0.26, g: 0.14 }] : [{ f: 660, to: 440, t: 0, d: 0.26, g: 0.14 }];
    case "fleet":
      return variant === "retired"
        ? [{ f: 660, to: 330, t: 0, d: 0.3, g: 0.12 }]
        : [
            { f: 880, t: 0, d: 0.12, g: 0.12 },
            { f: 1174.66, t: 0.06, d: 0.12, g: 0.12 },
            { f: 1567.98, t: 0.12, d: 0.22, g: 0.12 },
          ];
    default:
      return [];
  }
}

/** Fire the sound and haptic for an event, each only if its switch is on. Returns what played (tests). */
export function fx(event: FxEvent, variant?: FxVariant): { sound: boolean; haptic: boolean } {
  if (typeof document === "undefined" || document.visibilityState === "hidden") return { sound: false, haptic: false };
  const prefs = readFx();
  let sound = false;
  let haptic = false;
  if (fxEnabled("sound", event, prefs)) {
    const notes = recipe(event, variant);
    if (notes.length) {
      const duck = getSpeaking() ? 0.5 : 1;
      sound = play(notes, prefs.volume * duck);
    }
  }
  if (fxEnabled("haptics", event, prefs) && typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
    const pattern = HAPTICS[variant ? `${event}:${variant}` : event] ?? HAPTICS[event];
    if (pattern) {
      try {
        haptic = navigator.vibrate(pattern);
      } catch {
        haptic = false;
      }
    }
  }
  return { sound, haptic };
}

/** Settings preview: play one event's sound even if its switch is off (still respects master volume). */
export function previewSound(event: FxEvent, variant?: FxVariant) {
  unlockFx();
  play(recipe(event, variant), readFx().volume);
}

/** Settings preview: buzz one event's pattern (no-op where vibration is unsupported). */
export function previewHaptic(event: FxEvent, variant?: FxVariant) {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  const pattern = HAPTICS[variant ? `${event}:${variant}` : event] ?? HAPTICS[event];
  try {
    if (pattern) navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}

/** Which variant a settings preview uses for events that have several. */
export const PREVIEW_VARIANT: Partial<Record<FxEvent, FxVariant>> = { voice: "start", connection: "back", fleet: "minted" };

export const canVibrate = () => typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
