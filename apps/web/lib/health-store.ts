"use client";

import { useSyncExternalStore } from "react";

/**
 * Freshness of each polled resource (Fleet, Approvals, Chat, Today), shared so the header
 * connection dot can summarize them honestly while the detail lives in the status sheet.
 */
export type HealthEntry = { label: string; updatedAt: number | null; error: string | null; staleAfter: number };

const entries = new Map<string, HealthEntry>();
const listeners = new Set<() => void>();
let snapshot: HealthEntry[] = [];

function emit() {
  snapshot = [...entries.values()];
  for (const fn of listeners) fn();
}

export function reportHealth(entry: HealthEntry) {
  const prev = entries.get(entry.label);
  if (prev && prev.updatedAt === entry.updatedAt && prev.error === entry.error && prev.staleAfter === entry.staleAfter) return;
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

/** Degraded when any resource errored or went stale. Entries that never reported count once they pass their window. */
export function summarizeHealth(list: HealthEntry[], now: number, startedAt: number): HealthVerdict {
  let worst: HealthEntry | null = null;
  let worstAge = 0;
  for (const entry of list) {
    const age = Math.max(0, now - (entry.updatedAt ?? startedAt));
    const stale = !!entry.error || age >= entry.staleAfter;
    if (stale && age >= worstAge) {
      worst = entry;
      worstAge = age;
    }
  }
  return { state: worst ? "degraded" : "ok", worst, ageMs: worstAge };
}
