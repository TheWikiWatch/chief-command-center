/**
 * The live channel: one EventSource on the bridge's /events for the whole page.
 *
 * The bridge sends a `change` event whenever something the dashboard shows may have changed (a reply, a step,
 * a question, an approval, a bot starting or finishing work). Pollers subscribe with `onLiveChange` and refresh
 * at once; while the channel is up they stretch their timers (`liveInterval`), so a quiet dashboard makes
 * almost no requests. When it is down (gateway restarting, Tailscale hiccup) they fall back to their usual
 * rates and the channel retries with backoff, so a down gateway is never hammered.
 */

import { useSyncExternalStore } from "react";

type Listener = () => void;

const listeners = new Set<Listener>();
const stateListeners = new Set<Listener>();
let source: EventSource | null = null;
let connected = false;
let retryMs = 2000;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let pendingNotify: ReturnType<typeof setTimeout> | undefined;

function setConnected(next: boolean) {
  if (connected === next) return;
  connected = next;
  for (const fn of stateListeners) fn();
}

function notify() {
  // Several events in one moment become one refresh.
  if (pendingNotify) return;
  pendingNotify = setTimeout(() => {
    pendingNotify = undefined;
    for (const fn of [...listeners]) fn();
  }, 50);
}

function open() {
  if (source || typeof EventSource === "undefined" || !listeners.size) return;
  clearTimeout(retryTimer);
  const es = new EventSource("/api/bridge/events");
  source = es;
  es.onmessage = (e) => {
    // The bridge's own events (approved, outbox, clarify…) are changes too; "hello" confirms the channel.
    retryMs = 2000;
    setConnected(true);
    if (!String(e.data).includes('"hello"')) notify();
  };
  es.addEventListener("change", () => {
    retryMs = 2000;
    setConnected(true);
    notify();
  });
  es.onerror = () => {
    // The browser would retry on its own every few seconds; take over so retries back off.
    es.close();
    if (source === es) source = null;
    setConnected(false);
    if (!listeners.size) return;
    retryTimer = setTimeout(open, retryMs);
    retryMs = Math.min(retryMs * 2, 30_000);
  };
}

function close() {
  clearTimeout(retryTimer);
  source?.close();
  source = null;
  setConnected(false);
}

/** Call `fn` whenever the bridge reports a change. The channel opens with the first listener. */
export function onLiveChange(fn: Listener): () => void {
  listeners.add(fn);
  open();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) close();
  };
}

export function liveConnected(): boolean {
  return connected;
}

export function onLiveState(fn: Listener): () => void {
  stateListeners.add(fn);
  return () => stateListeners.delete(fn);
}

/** A poll interval that relaxes while the live channel is up: `fast` without it, `relaxed` with it. */
export function liveInterval(fast: number, relaxed: number): number {
  return connected ? relaxed : fast;
}

/** Test hook: forget the channel and every listener. */
export function resetLiveForTests() {
  close();
  listeners.clear();
  stateListeners.clear();
  retryMs = 2000;
}

/** For poll()'s `wake`: refresh on every change, and when the channel drops or returns. */
export function liveWake(fire: () => void): () => void {
  const offChange = onLiveChange(fire);
  const offState = onLiveState(fire);
  return () => {
    offChange();
    offState();
  };
}

/** Whether the live channel is up, as React state. */
export function useLiveConnected(): boolean {
  return useSyncExternalStore(onLiveState, liveConnected, () => false);
}
