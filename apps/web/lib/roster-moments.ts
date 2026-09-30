"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { readFx } from "@/lib/fx-prefs";
import { splitTitle } from "@/lib/names";
import { showToast } from "@/lib/toast-store";
import type { Person } from "@/lib/types";
import { assistantName } from "@/lib/identity";

/**
 * Turns roster changes between snapshots into moments (VISUAL-OVERHAUL §3.2, §12):
 * minted, retired, picked up work, finished. Never fires on the first roster, the first
 * one after a reconnect, or the first one after the app returns from the background,
 * so restarts and outages never produce a flood of toasts.
 */
export type RosterEvent =
  | { kind: "minted"; person: Person }
  | { kind: "retired"; person: Person }
  | { kind: "dispatched"; person: Person }
  | { kind: "finished"; person: Person; /** The same bot while it was still working (has the job title). */ previous?: Person };

/** Pure diff, exported for tests. */
export function diffRoster(prev: Map<string, Person>, next: Person[]): RosterEvent[] {
  const events: RosterEvent[] = [];
  const seen = new Set<string>();
  for (const p of next) {
    seen.add(p.id);
    const before = prev.get(p.id);
    if (!before) {
      events.push({ kind: "minted", person: p });
      if (p.ring === "working") events.push({ kind: "dispatched", person: p });
      continue;
    }
    if (before.ring !== "working" && p.ring === "working") events.push({ kind: "dispatched", person: p });
    if (before.ring === "working" && p.ring === "idle") events.push({ kind: "finished", person: p, previous: before });
  }
  for (const [id, p] of prev) if (!seen.has(id)) events.push({ kind: "retired", person: p });
  return events;
}

export type FleetMoments = {
  /** Profile ids minted in the last couple of seconds (materialize animation). */
  minted: ReadonlySet<string>;
  /** Profile ids celebrating a finished task. */
  celebrating: ReadonlySet<string>;
  /** Ids retired this session, so an open Look drawer can say so. */
  retired: ReadonlySet<string>;
  /** Call with every snapshot's roster as it arrives (see the hook). */
  markFresh: (roster: Person[]) => void;
};

const MINT_MS = 2400;
const CELEBRATE_MS = 1600;

function toastFor(event: RosterEvent, delay = 0) {
  if (!readFx().fleetToasts) return;
  const { name, role } = splitTitle(event.person.name);
  const who = name || event.person.id;
  const show = () => {
    if (event.kind === "minted") showToast({ title: `${assistantName()} added ${who}`, body: role || "New specialist", tone: "accent", icon: "user-plus" });
    else if (event.kind === "retired") showToast({ title: `${assistantName()} retired ${who}`, body: role || undefined, tone: "neutral", icon: "user-minus" });
    else if (event.kind === "dispatched") showToast({ title: `${who} picked up work`, body: event.person.jobTitle || role || undefined, tone: "accent", icon: "wrench" });
  };
  if (delay) setTimeout(show, delay);
  else show();
}

export function useFleetMoments(people: Person[], connected: boolean, onEvent?: (e: RosterEvent) => void): FleetMoments {
  const prev = useRef<Map<string, Person> | null>(null);
  const suppress = useRef(true);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const [minted, setMinted] = useState<Set<string>>(new Set());
  const [celebrating, setCelebrating] = useState<Set<string>>(new Set());
  const [retired, setRetired] = useState<Set<string>>(new Set());
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  // Polls share unchanged data, so an identical roster keeps its array and never re-runs the effect
  // below. The owner calls this on every snapshot that arrives: a pending baseline is taken from the
  // data itself, so a quiet reconnect can't leave suppression armed to swallow the next real mint.
  const markFresh = useCallback((roster: Person[]) => {
    if (!suppress.current || !connectedRef.current || !roster.length) return;
    prev.current = new Map(roster.map((p) => [p.id, p]));
    suppress.current = false;
  }, []);


  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") suppress.current = true;
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const lastArray = useRef<Person[] | null>(null);
  useEffect(() => {
    // While disconnected nothing is announced, and the first new roster after reconnecting is only a baseline.
    if (!connected) {
      suppress.current = true;
      return;
    }
    if (people === lastArray.current) return;
    lastArray.current = people;
    if (!people.length) return;
    const next = new Map(people.map((p) => [p.id, p]));
    const before = prev.current;
    prev.current = next;
    if (!before || suppress.current) {
      suppress.current = false;
      return;
    }
    const events = diffRoster(before, people);
    if (!events.length) return;
    const mintedNow = new Set(events.filter((e) => e.kind === "minted").map((e) => e.person.id));
    for (const e of events) {
      onEventRef.current?.(e);
      // A bot minted straight into work plays the mint first, then the dispatch.
      toastFor(e, e.kind === "dispatched" && mintedNow.has(e.person.id) ? 1400 : 0);
      if (e.kind === "minted") {
        setMinted((s) => new Set(s).add(e.person.id));
        setTimeout(() => setMinted((s) => {
          const n = new Set(s);
          n.delete(e.person.id);
          return n;
        }), MINT_MS);
      } else if (e.kind === "finished") {
        setCelebrating((s) => new Set(s).add(e.person.id));
        setTimeout(() => setCelebrating((s) => {
          const n = new Set(s);
          n.delete(e.person.id);
          return n;
        }), CELEBRATE_MS);
      } else if (e.kind === "retired") {
        setRetired((s) => new Set(s).add(e.person.id));
      }
    }
  }, [people, connected]);

  return { minted, celebrating, retired, markFresh };
}
