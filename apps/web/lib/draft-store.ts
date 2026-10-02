"use client";

import { useSyncExternalStore } from "react";

/**
 * The message box's text, outside React state: only the box subscribes to it, so typing re-renders the box
 * and nothing else (not the thread, its header or voice mode). The chat reads it with `get()` when it sends.
 */
export type DraftStore = {
  get: () => string;
  set: (next: string | ((current: string) => string)) => void;
  subscribe: (fn: () => void) => () => void;
};

export function createDraftStore(initial = ""): DraftStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => {
      const resolved = typeof next === "function" ? next(value) : next;
      if (resolved === value) return;
      value = resolved;
      for (const fn of listeners) fn();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export function useDraft(store: DraftStore): string {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
