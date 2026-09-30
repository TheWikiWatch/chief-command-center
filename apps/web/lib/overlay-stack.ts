"use client";

import { createContext, createElement, useContext, useEffect, useRef, type ReactNode } from "react";

/**
 * Sheets, drawers, the lightbox, voice mode, the phone's vault reader and non-Chat tabs are layers.
 * Only the top-most layer answers Escape and the Back button (Android's back gesture used to leave
 * the app from anywhere but voice mode, and one Escape closed every open sheet at once).
 *
 * Each layer adds one history entry, so Back pops exactly one layer. A layer closed by its own
 * button takes its entry back out. Layers inside a hidden phone tab (see LayerScope) step aside
 * until their tab is shown again, so Back never closes something you can't see.
 */
type Layer = { id: number; dismiss: () => boolean | void };

const stack: Layer[] = [];
let nextId = 1;
let wired = false;
/** History steps we made ourselves; their popstate must not dismiss anything. */
let ownBacks = 0;
/** Our layer depth of the current history entry. Tracked here because history steps are async. */
let historyDepth = 0;
/** Entries to step back over, batched into one history.go() (back-to-back back() calls can merge). */
let pendingBack = 0;

const depthOf = (state: unknown) =>
  state && typeof state === "object" && typeof (state as { chiefLayer?: unknown }).chiefLayer === "number"
    ? (state as { chiefLayer: number }).chiefLayer
    : 0;

function onPop(event: PopStateEvent) {
  if (ownBacks > 0) {
    ownBacks -= 1;
    return;
  }
  const depth = depthOf(event.state);
  historyDepth = depth;
  while (stack.length > depth) {
    const top = stack[stack.length - 1];
    if (top.dismiss() === false) {
      // This layer can't close right now (say, a send in flight): put its entry back.
      push(stack.length);
      return;
    }
    // The owner closes asynchronously; drop it here so its cleanup does not step back again.
    remove(top.id, false);
  }
}

function onKey(event: KeyboardEvent) {
  if (event.key !== "Escape" || !stack.length || event.defaultPrevented) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const top = stack[stack.length - 1];
  if (top.dismiss() === false) return;
}

function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  // A reload keeps history.state: the page may start on an entry tagged for a layer that is gone.
  historyDepth = 0;
  if (depthOf(window.history.state)) {
    try {
      window.history.replaceState({ ...window.history.state, chiefLayer: 0 }, "");
    } catch {
      /* ignore */
    }
  }
  window.addEventListener("popstate", onPop);
  // Capture phase, so the top layer handles Escape before anything else on the page.
  window.addEventListener("keydown", onKey, true);
}

function push(depth: number) {
  historyDepth = depth;
  try {
    const state = { ...(window.history.state || {}), chiefLayer: depth };
    // A layer that closed in this same tick left an entry at this depth: reuse it.
    if (pendingBack > 0) {
      pendingBack -= 1;
      window.history.replaceState(state, "");
    } else window.history.pushState(state, "");
  } catch {
    /* sandboxed: Escape still works */
  }
}

function doStepBack() {
  historyDepth -= 1;
  pendingBack += 1;
  if (pendingBack === 1) queueMicrotask(flushBack);
}

function flushBack() {
  const steps = pendingBack;
  pendingBack = 0;
  if (steps <= 0) return;
  ownBacks += 1;
  try {
    window.history.go(-steps);
  } catch {
    ownBacks -= 1;
  }
}

function remove(id: number, stepBack: boolean) {
  const at = stack.findIndex((layer) => layer.id === id);
  if (at < 0) return;
  const wasTop = at === stack.length - 1;
  stack.splice(at, 1);
  // Only the top entry can be taken back; a layer closed from underneath leaves a spare entry,
  // which a later Back press simply passes over.
  if (stepBack && wasTop && historyDepth === stack.length + 1) doStepBack();
}

/** Open a layer; returns a function that closes it (taking its history entry back). */
export function openLayer(dismiss: () => boolean | void): () => void {
  wire();
  const layer = { id: nextId++, dismiss };
  stack.push(layer);
  push(stack.length);
  return () => remove(layer.id, true);
}

export const layerDepth = () => stack.length;

const ScopeVisible = createContext(true);

/** Layers below a hidden scope (a phone tab that is not showing) are not layers until it shows. */
export function LayerScope({ visible, children }: { visible: boolean; children: ReactNode }) {
  const parent = useContext(ScopeVisible);
  return createElement(ScopeVisible.Provider, { value: parent && visible }, children);
}

/**
 * While `active`, this component is a layer: Escape and Back call `onDismiss` (return false to refuse).
 */
export function useLayer(active: boolean, onDismiss: () => boolean | void) {
  const visible = useContext(ScopeVisible);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const on = active && visible;
  useEffect(() => {
    if (!on) return;
    return openLayer(() => dismiss.current());
  }, [on]);
}

/** Test hook: forget every layer. */
export function resetLayers() {
  stack.splice(0);
  ownBacks = 0;
  pendingBack = 0;
  historyDepth = typeof window === "undefined" ? 0 : depthOf(window.history.state);
}
