"use client";

import { useSyncExternalStore } from "react";

/**
 * The last 20 speech attempts (PLAN-2026-09-23 §1), shown in the status sheet so a silent reply can be
 * traced: how long the voice took to prepare, whether sound started, and why it stopped.
 */
export type SpeechOutcome = "played" | "failed" | "stalled" | "missed" | "cancelled" | "skipped";
export type SpeechLogEntry = {
  at: number;
  preview: string;
  parts: number;
  /** Queue to first sound, when sound started. */
  firstSoundMs?: number;
  outcome: SpeechOutcome;
  reason?: string;
  hidden: boolean;
  metered: boolean;
};

const KEY = "chief-speech-log";
const MAX = 20;
const listeners = new Set<() => void>();
let cache: SpeechLogEntry[] | null = null;

function read(): SpeechLogEntry[] {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "[]");
    cache = Array.isArray(parsed) ? parsed.slice(0, MAX) : [];
  } catch {
    cache = [];
  }
  return cache;
}

export function logSpeech(entry: SpeechLogEntry) {
  cache = [entry, ...read()].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* private mode */
  }
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const EMPTY: SpeechLogEntry[] = [];
export function useSpeechLog(): SpeechLogEntry[] {
  return useSyncExternalStore(subscribe, () => (typeof window === "undefined" ? EMPTY : read()), () => EMPTY);
}
