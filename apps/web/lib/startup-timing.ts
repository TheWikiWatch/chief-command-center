"use client";

import { useSyncExternalStore } from "react";

/**
 * How long this start took, part by part, for the status sheet: "Opened in 3.1 s: app 1.2 s · team 0.4 s · chat
 * 0.8 s". Times are from the moment the page began loading (performance.now()), each marked once, when that part
 * first had the PC's answer. A tester's phone "loading for up to 30 seconds" was guesswork; this says which part.
 */
export type StartPart = "app" | "team" | "chat" | "today";
export const START_PARTS: StartPart[] = ["app", "team", "chat", "today"];

let marks: Partial<Record<StartPart, number>> = {};
let snapshot: { marks: Partial<Record<StartPart, number>>; at: number } = { marks, at: 0 };
const listeners = new Set<() => void>();

export function markStart(part: StartPart, now = typeof performance !== "undefined" ? performance.now() : 0) {
  if (marks[part] !== undefined) return;
  marks = { ...marks, [part]: Math.round(now) };
  snapshot = { marks, at: Date.now() };
  for (const fn of listeners) fn();
}

export function resetStartForTests() {
  marks = {};
  snapshot = { marks, at: 0 };
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const EMPTY: { marks: Partial<Record<StartPart, number>>; at: number } = { marks: {}, at: 0 };

export function useStartTiming() {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}

export const startSeconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);
