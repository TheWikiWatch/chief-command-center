"use client";

import { useSyncExternalStore } from "react";

export type ToastTone = "neutral" | "ok" | "warn" | "danger" | "accent";
export type ToastIcon = "sparkles" | "wrench" | "wifi" | "wifi-off" | "check" | "alert" | "user-plus" | "user-minus" | "bell";

export type Toast = {
  id: string;
  title: string;
  body?: string;
  tone?: ToastTone;
  icon?: ToastIcon;
  /** Milliseconds before auto-dismiss; 0 keeps it until dismissed. */
  duration?: number;
};

const MAX_VISIBLE = 2;
let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let seq = 0;

function emit() {
  for (const fn of listeners) fn();
}

export function dismissToast(id: string) {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  const next = toasts.filter((t) => t.id !== id);
  if (next.length !== toasts.length) {
    toasts = next;
    emit();
  }
}

/** Show a toast. A toast with an existing id replaces it in place. Oldest drop off past two. */
export function showToast(input: Omit<Toast, "id"> & { id?: string }): string {
  const id = input.id ?? `toast-${++seq}`;
  const toast: Toast = { duration: 3500, tone: "neutral", ...input, id };
  const without = toasts.filter((t) => t.id !== id);
  toasts = [...without, toast].slice(-MAX_VISIBLE);
  for (const [key, timer] of timers) {
    if (!toasts.some((t) => t.id === key)) {
      clearTimeout(timer);
      timers.delete(key);
    }
  }
  const old = timers.get(id);
  if (old) clearTimeout(old);
  if (toast.duration) timers.set(id, setTimeout(() => dismissToast(id), toast.duration));
  emit();
  return id;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const EMPTY: Toast[] = [];

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts, () => EMPTY);
}
