"use client";

import { useSyncExternalStore } from "react";

/**
 * How quickly this window reaches the PC: the round trip of the app's own health check (every 15 s or so), the
 * median of the last few. On a phone that is the whole path over Tailscale, so the status sheet can say plainly
 * when the link, not the chief, is what's slow (a relayed connection takes seconds where a direct one takes tens
 * of milliseconds).
 */
const KEEP = 5;
const samples: number[] = [];
const listeners = new Set<() => void>();
let snapshot: LinkQuality = { ms: null, samples: 0 };

export type LinkQuality = { ms: number | null; samples: number };
export type LinkRating = "fast" | "ok" | "slow";

export function noteRoundTrip(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return;
  samples.push(ms);
  if (samples.length > KEEP) samples.shift();
  const sorted = [...samples].sort((a, b) => a - b);
  snapshot = { ms: Math.round(sorted[Math.floor(sorted.length / 2)]), samples: samples.length };
  for (const fn of listeners) fn();
}

/** Under 300 ms feels instant; under a second is usable; beyond that every tap waits. */
export function rateLink(ms: number): LinkRating {
  return ms < 300 ? "fast" : ms < 1000 ? "ok" : "slow";
}

export function resetLinkQualityForTests() {
  samples.splice(0);
  snapshot = { ms: null, samples: 0 };
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
const EMPTY: LinkQuality = { ms: null, samples: 0 };

export function useLinkQuality(): LinkQuality {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}
