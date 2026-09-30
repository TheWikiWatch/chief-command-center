"use client";

import { useEffect, useState } from "react";

import { fetchFleetFlags, FLAGS_SEEN_EVENT, loadSeenFlags, unseenFlags, type Flag } from "@/lib/fleet-health";
import { poll } from "@/lib/poll";

/** How many fleet flags this device hasn't looked at in Health (the ledger reports every 30 minutes). */
export function useUnseenFleetFlags(enabled = true, pollMs = 5 * 60_000): number {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  useEffect(
    () => {
      if (!enabled) {
        setFlags([]);
        return undefined;
      }
      return poll(async (signal) => {
        try {
          const res = await fetchFleetFlags(signal);
          if (!signal.aborted) setFlags(res.flags || []);
        } catch {
          /* no report yet, or the ledger is behind: no badge */
        }
      }, pollMs);
    },
    [enabled, pollMs],
  );
  useEffect(() => {
    const load = () => setSeen(loadSeenFlags());
    load();
    window.addEventListener(FLAGS_SEEN_EVENT, load);
    return () => window.removeEventListener(FLAGS_SEEN_EVENT, load);
  }, []);
  return unseenFlags(flags, seen).length;
}
