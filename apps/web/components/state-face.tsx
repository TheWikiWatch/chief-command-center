"use client";

import { useSyncExternalStore } from "react";

import { BotFace, type FaceMood } from "@/components/bot-face";
import { LAST_CHIEF_KEY } from "@/lib/identity";

/**
 * The chief's face for an empty or offline state, in a pose that fits: asleep when something is out of reach,
 * celebrating when the list is clear, waiting when there's nothing yet. It uses the chief this device last saw,
 * so it matches the chief's own face even while the gateway is down.
 */
function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function lastChiefRaw(): string | null {
  try {
    return localStorage.getItem(LAST_CHIEF_KEY);
  } catch {
    return null;
  }
}

export function StateFace({ mood, size = 64 }: { mood: FaceMood; size?: number }) {
  const raw = useSyncExternalStore(subscribe, lastChiefRaw, () => null);
  let chief: { name?: string; shape?: string; color?: string; custom?: boolean } = {};
  try {
    chief = raw ? JSON.parse(raw) : {};
  } catch {
    chief = {};
  }
  return (
    <span aria-hidden className="block">
      <BotFace name={chief.name || "Chief"} profileId="chief" shape={chief.shape} color={chief.color} custom={chief.custom} isChief size={size} mood={mood} />
    </span>
  );
}
