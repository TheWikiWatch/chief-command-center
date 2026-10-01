"use client";

import { useGaze } from "@blobatar/react/gaze";
import { useCallback, useRef } from "react";

import { useFaceClock } from "@/lib/face-clock";
import { attentionWeight, pointerReactive, readPointer } from "@/lib/pointer";

/** Attention hysteresis: engage above this weight, let go below the lower one, so the eyes never flap. */
const ENGAGE = 0.35;
const RELEASE = 0.12;

/**
 * Where the chief's eyes go (PLAN-2026-09-26 §3), on top of the Blobatar gaze driver, which glides
 * between targets by itself:
 *  1. straight out at you while the cursor is on it;
 *  2. the bot it is working with, while one is working (re-aimed as its seat moves);
 *  3. your cursor while it is near and has moved recently;
 *  4. otherwise nothing: its eyes come home and its own idle glances return.
 */
export function useAttentiveGaze(task: () => HTMLElement | null) {
  const { ref: gazeRef, lookAt } = useGaze({ travel: 3, lookAt: null });
  const node = useRef<Element | null>(null);
  const taskRef = useRef(task);
  taskRef.current = task;
  const s = useRef({ kind: "", at: -1, engaged: false, px: NaN, py: NaN, box: null as { cx: number; cy: number; size: number } | null });

  const ref = useCallback(
    (el: SVGSVGElement | HTMLImageElement | null) => {
      node.current = el;
      gazeRef(el);
    },
    [gazeRef],
  );

  const aim = (kind: string, t: number, target: Parameters<typeof lookAt>[0]) => {
    s.current.kind = kind;
    s.current.at = t;
    lookAt(target);
  };

  useFaceClock(
    node,
    (t) => {
      const st = s.current;
      const p = readPointer();
      const box = st.box;
      const dx = p && box ? p.x - box.cx : Infinity;
      const dy = p && box ? p.y - box.cy : Infinity;
      if (box && Math.abs(dx) < box.size / 2 + 6 && Math.abs(dy) < box.size / 2 + 6) {
        st.engaged = false;
        if (st.kind !== "rest") aim("rest", t, "rest");
        return;
      }
      const taskEl = taskRef.current();
      if (taskEl) {
        st.engaged = false;
        if (st.kind !== "task" || t - st.at > 0.4 || t < st.at) aim("task", t, taskEl);
        return;
      }
      if (p && box) {
        const w = attentionWeight(Math.hypot(dx, dy), p.idle, box.size);
        st.engaged = st.engaged ? w > RELEASE : w > ENGAGE;
        if (st.engaged) {
          if (st.kind !== "pointer" || Math.abs(p.x - st.px) + Math.abs(p.y - st.py) > 2) {
            st.px = p.x;
            st.py = p.y;
            aim("pointer", t, { x: p.x, y: p.y });
          }
          return;
        }
      }
      if (st.kind !== "idle") aim("idle", t, null);
    },
    true,
    () => {
      const el = node.current;
      if (!el || !pointerReactive() || !readPointer()) {
        s.current.box = null;
        return;
      }
      const r = el.getBoundingClientRect();
      s.current.box = r.width ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2, size: Math.max(r.width, r.height) } : null;
    },
  );

  return { ref };
}
