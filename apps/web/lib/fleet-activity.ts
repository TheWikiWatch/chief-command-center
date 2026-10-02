"use client";

import { useSyncExternalStore } from "react";

import { splitTitle } from "@/lib/names";
import type { RosterEvent } from "@/lib/roster-moments";

/**
 * The Fleet's activity this session: who was brought on or retired, who picked up work and who finished, newest
 * first. It lives in memory only (the roster's history isn't stored anywhere), and keeps the last few dozen.
 */
export type ActivityItem = { key: string; at: number; personId: string; who: string; kind: RosterEvent["kind"]; detail: string };

const LIMIT = 40;
let items: ActivityItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();

export function recordRosterEvent(event: RosterEvent, at = Date.now()): void {
  const { name, role } = splitTitle(event.person.name);
  const detail =
    event.kind === "dispatched"
      ? event.person.jobTitle || ""
      : event.kind === "finished"
        ? event.previous?.jobTitle || ""
        : role || "";
  items = [{ key: `a${++seq}`, at, personId: event.person.id, who: name || event.person.id, kind: event.kind, detail }, ...items].slice(0, LIMIT);
  for (const l of listeners) l();
}

/** Tests only. */
export function resetFleetActivity(): void {
  items = [];
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

const NONE: ActivityItem[] = [];

export function useFleetActivity(): ActivityItem[] {
  return useSyncExternalStore(subscribe, () => items, () => NONE);
}

export function activityVerb(kind: RosterEvent["kind"], assistant: string): string {
  return kind === "minted" ? `joined, brought on by ${assistant}` : kind === "retired" ? "was retired" : kind === "dispatched" ? "picked up work" : "finished";
}
