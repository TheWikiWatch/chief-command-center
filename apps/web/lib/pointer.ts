"use client";

/**
 * Where the mouse is, for faces that notice it (PLAN-2026-09-26 Phase 3). One passive listener
 * for the whole page writes two numbers; faces read them on the shared face clock, so the pointer
 * never causes a React render. Only mice and trackpads count: touch has no hover and no cursor.
 */
type PointerState = { x: number; y: number; at: number; inside: boolean };

const state: PointerState = { x: 0, y: 0, at: -Infinity, inside: false };
let wired = false;
let fine: MediaQueryList | null = null;

function wire() {
  if (wired || typeof window === "undefined") return;
  wired = true;
  try {
    fine = typeof window.matchMedia === "function" ? window.matchMedia("(hover: hover) and (pointer: fine)") : null;
  } catch {
    fine = null;
  }
  window.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType === "touch") return;
      state.x = e.clientX;
      state.y = e.clientY;
      state.at = performance.now();
      state.inside = true;
    },
    { passive: true },
  );
  // Leaving the window (relatedTarget null) or the tab hiding: nobody is pointing anywhere.
  document.addEventListener("pointerout", (e) => {
    if (!e.relatedTarget) state.inside = false;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") state.inside = false;
  });
}

/** Faces may react to the pointer: a fine pointer, motion allowed, ambience not Off. */
export function pointerReactive(): boolean {
  wire();
  if (typeof document === "undefined" || !fine?.matches) return false;
  return document.documentElement.dataset.ambient !== "off";
}

/** The pointer now, with seconds since it last moved; null when it is outside the window. */
export function readPointer(): { x: number; y: number; idle: number } | null {
  wire();
  if (!state.inside) return null;
  return { x: state.x, y: state.y, idle: (performance.now() - state.at) / 1000 };
}

/** Test hook: place the pointer as if it had just moved there (or take it away). */
export function setPointerForTest(p: { x: number; y: number; idle?: number } | null) {
  if (!p) {
    state.inside = false;
    return;
  }
  state.x = p.x;
  state.y = p.y;
  state.at = performance.now() - (p.idle ?? 0) * 1000;
  state.inside = true;
}

const smooth = (edge0: number, edge1: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** Attention radius in px: 320 around a 72px face, scaled gently with face size. */
export function attentionRadius(sizePx: number) {
  return 240 + Math.min(200, sizePx * 1.1);
}

/**
 * How much a face attends to the cursor, 0..1: near (eases in from the radius to ~80px) times
 * recent (full until 1.2s after the last move, gone by 2.5s). It always decays, so a face never
 * locks onto a parked cursor and goes back to its own idle glances.
 */
export function attentionWeight(distPx: number, idleS: number, sizePx: number) {
  const near = 1 - smooth(Math.max(40, sizePx * 0.6 + 40), attentionRadius(sizePx), distPx);
  const recent = 1 - smooth(1.2, 2.5, idleS);
  return near * recent;
}

export type Look = {
  /** Direction to the cursor, -1..1 on each axis (screen space). */
  x: number;
  y: number;
  /** Eased attention weight 0..1. */
  w: number;
  /** The cursor is over this face right now. */
  hover: boolean;
  /** Seconds since hover began (Infinity when not hovering). */
  hoverFor: number;
  /** Seconds left of a blink started by a big gaze jump (0 when none). */
  blink: number;
};

export type LookState = Look & { last: number; hoverAt: number; blinkUntil: number; box: { cx: number; cy: number; size: number } | null };

export const lookState = (): LookState => ({ x: 0, y: 0, w: 0, hover: false, hoverFor: Infinity, blink: 0, last: -1, hoverAt: -1, blinkUntil: -1, box: null });

/** Measure pass (reads layout): where this face is on screen, only while the pointer matters. */
export function measureLook(s: LookState, el: Element | null) {
  if (!el || !pointerReactive() || !readPointer()) {
    s.box = null;
    return;
  }
  const r = el.getBoundingClientRect();
  s.box = r.width ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2, size: Math.max(r.width, r.height) } : null;
}

/**
 * Update pass (pure arithmetic on the measured box): smooth pursuit toward the cursor, weight easing,
 * hover edge, and a blink when the eyes have to jump a long way.
 */
export function stepLook(s: LookState, t: number): Look {
  const dt = s.last < 0 || t < s.last ? 0 : Math.min(0.1, t - s.last);
  s.last = t;
  const p = readPointer();
  const box = s.box;
  let tx = s.x;
  let ty = s.y;
  let target = 0;
  let hover = false;
  if (p && box) {
    const dx = p.x - box.cx;
    const dy = p.y - box.cy;
    const dist = Math.hypot(dx, dy);
    hover = Math.abs(dx) < box.size / 2 + 6 && Math.abs(dy) < box.size / 2 + 6;
    target = hover ? 1 : attentionWeight(dist, p.idle, box.size);
    // Direction saturates a little past the face so near and far both read as "over there".
    const reach = Math.max(box.size * 1.5, 90);
    tx = Math.max(-1, Math.min(1, dx / reach));
    ty = Math.max(-1, Math.min(1, dy / reach));
  }
  const k = (tau: number) => (dt ? 1 - Math.exp(-dt / tau) : 1);
  if (target > 0.05 && Math.hypot(tx - s.x, ty - s.y) > 1.2 && s.w > 0.3) s.blinkUntil = t + 0.16;
  if (target > 0.05) {
    s.x += (tx - s.x) * k(0.11);
    s.y += (ty - s.y) * k(0.11);
  }
  s.w += (target - s.w) * k(target > s.w ? 0.2 : 0.45);
  if (hover && !s.hover) s.hoverAt = t;
  s.hover = hover;
  s.hoverFor = hover ? t - s.hoverAt : Infinity;
  s.blink = Math.max(0, s.blinkUntil - t);
  return s;
}
