"use client";

import { useSyncExternalStore } from "react";

/**
 * Freshness of each polled resource (Fleet, Approvals, Chat, Today), shared so the header
 * connection dot can summarize them honestly while the detail lives in the status sheet.
 */
export type HealthEntry = {
  label: string;
  updatedAt: number | null;
  error: string | null;
  staleAfter: number;
  /** A request is open right now (a long-poll waiting for news): connected, not stale, while younger than staleAfter. */
  pendingSince?: number | null;
  /** Failures in a row; one alone is a blip (a dropped request on a phone), two are a problem. */
  failures?: number;
};

/**
 * How long a resource polled every `intervalMs` may go without an answer before it is stale: two missed polls plus
 * time for a slow answer. Every window comes from the schedule the resource really uses (a phone tab that isn't
 * showing checks once a minute), so a quiet resource on a slow schedule never reads as a problem.
 */
export function staleWindow(intervalMs: number): number {
  return intervalMs * 2 + 10_000;
}

/** After coming back to the app (or back online), this long to catch up before anything is called stale. */
export const RESUME_GRACE_MS = 15_000;
let resumedAt = 0;

/** The app came back to the foreground or the network came back: requests restart (lib/poll.ts), give them a moment. */
export function noteResume(at = Date.now()) {
  resumedAt = at;
  emit();
}

if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") noteResume();
  });
  window.addEventListener("online", () => noteResume());
  window.addEventListener("pageshow", (e) => {
    if ((e as PageTransitionEvent).persisted) noteResume();
  });
}

const entries = new Map<string, HealthEntry>();
const listeners = new Set<() => void>();
let snapshot: HealthEntry[] = [];

function emit() {
  snapshot = [...entries.values()];
  for (const fn of listeners) fn();
}

export function reportHealth(entry: HealthEntry) {
  const prev = entries.get(entry.label);
  if (
    prev &&
    prev.updatedAt === entry.updatedAt &&
    prev.error === entry.error &&
    prev.staleAfter === entry.staleAfter &&
    (prev.pendingSince ?? null) === (entry.pendingSince ?? null) &&
    (prev.failures ?? 0) === (entry.failures ?? 0)
  )
    return;
  entries.set(entry.label, entry);
  emit();
}

export function forgetHealth(label: string) {
  if (entries.delete(label)) emit();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const EMPTY: HealthEntry[] = [];

export function useHealthEntries(): HealthEntry[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}

export type HealthVerdict = { state: "ok" | "degraded"; worst: HealthEntry | null; ageMs: number };

/**
 * Degraded only when something is really wrong: a resource failed twice in a row, or has had neither an answer nor an
 * open request for longer than its window. Just after returning to the app (RESUME_GRACE_MS) nothing is stale yet:
 * the requests a phone froze in the background are being replaced. Entries that never reported count once they pass
 * their window.
 */
export function summarizeHealth(list: HealthEntry[], now: number, startedAt: number, resumed = resumedAt): HealthVerdict {
  let worst: HealthEntry | null = null;
  let worstAge = 0;
  const settling = resumed > 0 && now - resumed < RESUME_GRACE_MS;
  for (const entry of list) {
    const age = Math.max(0, now - (entry.updatedAt ?? startedAt));
    const errored = !!entry.error && (entry.failures ?? 2) >= 2;
    const open = !!entry.pendingSince && now - entry.pendingSince < entry.staleAfter;
    const stale = errored || (!open && !settling && now - Math.max(entry.updatedAt ?? startedAt, resumed) >= entry.staleAfter);
    if (stale && age >= worstAge) {
      worst = entry;
      worstAge = age;
    }
  }
  return { state: worst ? "degraded" : "ok", worst, ageMs: worstAge };
}
