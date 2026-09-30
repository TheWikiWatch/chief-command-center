"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";

import type { Person } from "@/lib/types";

const TIP_WIDTH = 264;

export function useBotTip() {
  const [open, setOpen] = useState(false);
  const timer = useRef(0);
  const tipId = useId();

  function show() {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 300);
  }

  function hide() {
    window.clearTimeout(timer.current);
    setOpen(false);
  }

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return { open, show, hide, tipId };
}

export function BotTip({
  person,
  open,
  id,
  anchor,
  paneRef,
  placement,
}: {
  person: Person;
  open: boolean;
  id: string;
  anchor: HTMLElement | null;
  paneRef?: RefObject<HTMLElement | null>;
  placement: "orbit" | "rail";
}) {
  const [style, setStyle] = useState<CSSProperties>({});
  const boxRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return;

    const place = () => {
      const a = anchor.getBoundingClientRect();
      const p = paneRef?.current?.getBoundingClientRect();
      const tip = boxRef.current?.getBoundingClientRect();
      const w = tip?.width || TIP_WIDTH;
      const h = tip?.height || 96;
      let left: number;
      let top: number;
      if (placement === "rail") {
        left = a.right + 10;
        top = a.top + a.height / 2 - h / 2;
      } else {
        left = a.left + a.width / 2 - w / 2;
        top = a.top - h - 10;
        if (p && top < p.top + 8) top = a.bottom + 10;
      }
      const minL = p ? p.left + 8 : 8;
      const maxL = p ? p.right - w - 8 : window.innerWidth - w - 8;
      const minT = p ? p.top + 8 : 8;
      const maxT = p ? p.bottom - h - 8 : window.innerHeight - h - 8;
      left = Math.min(Math.max(left, minL), Math.max(minL, maxL));
      top = Math.min(Math.max(top, minT), Math.max(minT, maxT));
      setStyle({ position: "fixed", left, top, width: TIP_WIDTH, zIndex: 80 });
    };

    place();
    const raf = window.requestAnimationFrame(place);
    const pane = paneRef?.current;
    pane?.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.cancelAnimationFrame(raf);
      pane?.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, anchor, paneRef, placement, person.id]);

  if (!open || typeof document === "undefined") return null;

  const desc = (person.description || "").trim();
  const title = (person.title || "").trim();
  const showTitle = Boolean(title && title !== person.name);

  return createPortal(
    <div ref={boxRef} id={id} role="tooltip" style={style} className="bot-tip bot-tip-in pointer-events-none">
      <div className="font-semibold text-white">{person.name}</div>
      {showTitle ? <div className="text-white/55">{title}</div> : null}
      {desc ? <div className="bot-tip-desc mt-1 text-white/70">{desc}</div> : null}
      {person.flavor ? (
        <div className="mt-1.5 text-[10px] uppercase tracking-[0.14em] text-chief/85">{person.flavor}</div>
      ) : null}
    </div>,
    document.body,
  );
}
