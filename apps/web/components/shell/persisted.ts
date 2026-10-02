"use client";

import { type PhoneTab } from "@/components/phone-nav";
import { type Surface } from "@/components/surface-tabs";
import { LAST_CHIEF_KEY, readLastChief } from "@/lib/identity";
import type { Person } from "@/lib/types";

/* What the shell keeps on this device: the split, the surface, the phone tab, the fleet view and the last-known chief. */

export const STORAGE_KEY = "chief-split";

export const SURFACE_KEY = "chief-surface";

export const PHONE_TAB_KEY = "chief-phone-tab";

export const FLEET_VIEW_KEY = "chief-fleet-view";

export type FleetView = "crew" | "health";

export function rememberChief(p: Person) {
  try {
    localStorage.setItem(LAST_CHIEF_KEY, JSON.stringify({ ...p, ring: "idle", jobTitle: "" }));
  } catch {
    /* ignore */
  }
}

/** The last-known chief (shown asleep while the gateway is down); older devices' records lack `isChief`. */
export function loadChief(): Person | null {
  const p = readLastChief() as Person | null;
  return p ? { ...p, isChief: true } : null;
}

export function loadSurface(): Surface {
  try {
    const raw = localStorage.getItem(SURFACE_KEY);
    if (raw === "fleet" || raw === "today" || raw === "vault") return raw;
  } catch {
    /* ignore */
  }
  return "today";
}

export function loadPhoneTab(): PhoneTab {
  try {
    const raw = localStorage.getItem(PHONE_TAB_KEY);
    if (raw === "chat" || raw === "today" || raw === "fleet" || raw === "vault") return raw;
  } catch {
    /* ignore */
  }
  return "chat";
}

export function loadSplit() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw ? Number(raw) : 60;
    if (n >= 52) return 60;
    if (n > 0) return 40;
  } catch {
    /* ignore */
  }
  return 60;
}
