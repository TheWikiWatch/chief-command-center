"use client";

import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent, type ReactElement } from "react";
import { createPortal } from "react-dom";

import { LAYER } from "@/lib/layers";

/**
 * Tooltips: `Tip` labels an icon button on hover or keyboard focus, with its keyboard shortcut when it has one.
 * Touch doesn't show tooltips, so a tip never holds the only copy of anything (the button keeps its aria-label).
 *
 * Hand-rolled on purpose: a tooltip library (Base UI's pulls in floating-ui) cost about 30 KB of the first load
 * for a label under a button. Menus, which need real focus management, are in `action-menu.tsx`.
 */
const DELAY_MS = 450;
const GAP = 8;
const EDGE = 8;

type Side = "top" | "bottom" | "left" | "right";

export function Tip({ label, shortcut, children, side = "bottom" }: { label: string; shortcut?: string; children: ReactElement; side?: Side }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const tip = useRef<HTMLDivElement>(null);
  const id = useId();

  const clear = () => window.clearTimeout(timer.current);
  const hide = () => {
    clear();
    setAnchor(null);
  };
  useEffect(() => clear, []);
  useEffect(() => {
    if (!anchor) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setAnchor(null);
    const onScroll = () => setAnchor(null);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [anchor]);

  // Place it beside the anchor, kept inside the window.
  useLayoutEffect(() => {
    const el = tip.current;
    if (!anchor || !el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let top = side === "top" ? anchor.top - GAP - h : side === "bottom" ? anchor.bottom + GAP : anchor.top + anchor.height / 2 - h / 2;
    let left = side === "left" ? anchor.left - GAP - w : side === "right" ? anchor.right + GAP : anchor.left + anchor.width / 2 - w / 2;
    if (side === "bottom" && top + h > window.innerHeight - EDGE) top = anchor.top - GAP - h;
    if (side === "top" && top < EDGE) top = anchor.bottom + GAP;
    left = Math.min(Math.max(EDGE, left), window.innerWidth - EDGE - w);
    top = Math.min(Math.max(EDGE, top), window.innerHeight - EDGE - h);
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    el.style.opacity = "1";
  }, [anchor, side]);

  // The handlers sit on a `display: contents` wrapper (React's mouse and focus events reach it from the button);
  // the button itself only gains `aria-describedby`.
  const box = (el: HTMLElement) => (el.firstElementChild ?? el).getBoundingClientRect();
  const trigger = cloneElement(children, { "aria-describedby": anchor ? id : undefined } as Record<string, unknown>);
  const onMouseEnter = (e: MouseEvent<HTMLElement>) => {
    // A tap fires mouse events too: touch-only screens never show tips.
    if (window.matchMedia?.("(hover: none)").matches) return;
    const rect = box(e.currentTarget);
    clear();
    timer.current = window.setTimeout(() => setAnchor(rect), DELAY_MS);
  };
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    // Keyboard focus only: a click also focuses, and shouldn't pop a label up.
    if ((e.target as HTMLElement).matches(":focus-visible")) setAnchor(box(e.currentTarget));
  };

  return (
    <>
      <span className="contents" onMouseEnter={onMouseEnter} onMouseLeave={hide} onPointerDown={hide} onFocus={onFocus} onBlur={hide}>
        {trigger}
      </span>
      {anchor
        ? createPortal(
            <div
              ref={tip}
              id={id}
              role="tooltip"
              className="pointer-events-none fixed left-0 top-0 flex items-center gap-2 rounded-ctl border border-line-2 bg-raised px-2.5 py-1.5 text-caption text-fg opacity-0 shadow-e3 transition-opacity duration-fast"
              style={{ zIndex: LAYER.hoverCard }}
            >
              <span>{label}</span>
              {shortcut ? <kbd className="rounded-chip border border-line-2 bg-fill-1 px-1.5 font-mono text-micro text-fg-3">{shortcut}</kbd> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
