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

let state: Identity = { assistant: readStoredName() || DEFAULT_ASSISTANT_NAME, owner: "" };
const listeners = new Set<() => void>();

function readStoredName(): string {
  try {
    if (typeof localStorage === "undefined") return "";
    const saved = (localStorage.getItem(NAME_KEY) || "").trim();
    if (saved) return saved;
    // Devices that ran earlier versions remember the whole chief record under this key.
    const legacy = JSON.parse(localStorage.getItem("chief-last-chief") || "null") as { name?: string } | null;
    return splitTitle(legacy?.name).name;
  } catch {
    return "";
  }
}

function emit(next: Identity) {
  if (next.assistant === state.assistant && next.owner === state.owner) return;
  state = next;
  for (const listener of listeners) listener();
}

/** Set the chief's display name from its roster title (for example "Chief - Chief of Staff" → "Chief"). */
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
  return useSyncExternalStore(subscribe, () => state, () => ({ assistant: DEFAULT_ASSISTANT_NAME, owner: "" }));
}

export function useAssistantName(): string {
  return useIdentity().assistant;
}

/** For tests. */
export function resetIdentity() {
  state = { assistant: DEFAULT_ASSISTANT_NAME, owner: "" };
  for (const listener of listeners) listener();
}
