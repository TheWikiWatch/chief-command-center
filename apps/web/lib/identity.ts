"use client";

import { useSyncExternalStore } from "react";

import { splitTitle } from "@/lib/names";

/**
 * Who the chief is and who the owner is, for words on screen.
 *
 * The chief's name comes from its own Hermes profile (the roster's chief title, "Name - Role"), so a
 * renamed or brand-new chief is named correctly everywhere. Until the roster has arrived it falls back
 * to the last name this device saw, then to "Chief". The owner's name comes from the app config
 * (/api/app/config); empty means "don't address anyone by name".
 */
export const DEFAULT_ASSISTANT_NAME = "Chief";
const NAME_KEY = "chief-assistant-name";

type Identity = { assistant: string; owner: string };
/** What the server render sees: one constant object (React requires a stable server snapshot). */
const SERVER_IDENTITY: Identity = { assistant: DEFAULT_ASSISTANT_NAME, owner: "" };

let state: Identity = { assistant: readStoredName() || DEFAULT_ASSISTANT_NAME, owner: "" };
const listeners = new Set<() => void>();

function readStoredName(): string {
  try {
    if (typeof localStorage === "undefined") return "";
    const saved = (localStorage.getItem(NAME_KEY) || "").trim();
    if (saved) return saved;
    // Otherwise the last chief record this device saw (devices that ran earlier versions have only that).
    return splitTitle((readLastChief() as { name?: string } | null)?.name).name;
  } catch {
    return "";
  }
}

/** The chief's last-known roster entry, kept so the app can show it while the gateway is unreachable. */
export const LAST_CHIEF_KEY = "chief-last-known";

/**
 * The saved chief record, or null. Earlier versions kept it under another `chief-last-…` key; it is moved
 * here once, and recognised by the chief's profile id ("chief"), which every version wrote.
 */
export function readLastChief(): Record<string, unknown> | null {
  try {
    if (typeof localStorage === "undefined") return null;
    let raw = localStorage.getItem(LAST_CHIEF_KEY);
    if (!raw) {
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith("chief-last-") || key === LAST_CHIEF_KEY) continue;
        raw = localStorage.getItem(key);
        localStorage.removeItem(key);
        if (raw) localStorage.setItem(LAST_CHIEF_KEY, raw);
        break;
      }
    }
    const record = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    return record && record.id === "chief" ? record : null;
  } catch {
    return null;
  }
}

function emit(next: Identity) {
  if (next.assistant === state.assistant && next.owner === state.owner) return;
  state = next;
  for (const listener of listeners) listener();
}

/** Set the chief's display name from its roster title (for example "Nova - Chief of Staff" → "Nova"). */
export function setAssistantTitle(title: string | undefined | null) {
  const name = splitTitle(title).name.trim();
  if (!name) return;
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode */
  }
  emit({ ...state, assistant: name });
}

export function setOwnerName(name: string | undefined | null) {
  emit({ ...state, owner: String(name || "").trim() });
}

/** Current names, for code outside React (toasts, media session titles). */
export function assistantName(): string {
  return state.assistant;
}

export function ownerName(): string {
  return state.owner;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useIdentity(): Identity {
  return useSyncExternalStore(subscribe, () => state, () => SERVER_IDENTITY);
}

export function useAssistantName(): string {
  return useIdentity().assistant;
}

/** For tests. */
export function resetIdentity() {
  state = { assistant: DEFAULT_ASSISTANT_NAME, owner: "" };
  for (const listener of listeners) listener();
}
