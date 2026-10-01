"use client";

import { useId, useRef, type RefObject } from "react";

import { useFaceClock } from "@/lib/face-clock";

type Props = {
  containerRef: RefObject<HTMLElement | null>;
  fromRef: RefObject<HTMLElement | null>;
  toRef: RefObject<HTMLElement | null>;
  curvature?: number;
  /** One-shot beam (mint moment): the comet travels once and the beam fades. */
  once?: boolean;
  tone?: "accent" | "mint";
};

function center(el: HTMLElement, box: DOMRect) {
  const r = el.getBoundingClientRect();
  return { x: r.left - box.left + r.width / 2, y: r.top - box.top + r.height / 2 };
}

/**
 * Beam from the chief to a specialist with a comet head (VISUAL-OVERHAUL §3.2). The path is
 * recomputed on the shared clock, so it follows seats that drift or orbit, without React renders.
 */
export function AnimatedBeam({ containerRef, fromRef, toRef, curvature = 40, once = false, tone = "accent" }: Props) {
  const id = useId().replace(/:/g, "");
  const svg = useRef<SVGSVGElement>(null);
  const base = useRef<SVGPathElement>(null);
  const trail = useRef<SVGPathElement>(null);
  const head = useRef<SVGCircleElement>(null);
  const core = useRef<SVGCircleElement>(null);
  const start = useRef<number | null>(null);

  useFaceClock(svg, (t) => {
    const box = containerRef.current?.getBoundingClientRect();
    const a = fromRef.current;
    const b = toRef.current;
    if (!box || !a || !b || !base.current || !trail.current || !head.current) return;
    const p1 = center(a, box);
    const p2 = center(b, box);
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2 - curvature;
    const d = `M ${p1.x.toFixed(1)},${p1.y.toFixed(1)} Q ${mx.toFixed(1)},${my.toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`;
    base.current.setAttribute("d", d);
    trail.current.setAttribute("d", d);
    const len = trail.current.getTotalLength?.() || 0;
    if (!len) return;
    if (start.current === null) start.current = t;
    const elapsed = t - start.current;
    let u: number;
    let fade = 1;
    if (once) {
      const k = Math.min(1, elapsed / 1.2);
      u = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      fade = elapsed < 1.2 ? 1 : Math.max(0, 1 - (elapsed - 1.2) / 0.6);
    } else {
      u = (elapsed / 1.9) % 1;
    }
    const dash = len * 0.28;
    trail.current.setAttribute("stroke-dasharray", `${dash.toFixed(1)} ${len.toFixed(1)}`);
    trail.current.setAttribute("stroke-dashoffset", (dash - u * (len + dash)).toFixed(1));
    const pt = trail.current.getPointAtLength(Math.min(len, u * len));
    head.current.setAttribute("cx", pt.x.toFixed(1));
    head.current.setAttribute("cy", pt.y.toFixed(1));
    core.current?.setAttribute("cx", pt.x.toFixed(1));
    core.current?.setAttribute("cy", pt.y.toFixed(1));
    svg.current?.setAttribute("opacity", fade.toFixed(2));
  });

  const color = tone === "mint" ? "rgb(var(--c-ok))" : "rgb(var(--c-accent))";
  return (
    <svg ref={svg} aria-hidden="true" className="pointer-events-none absolute inset-0 z-0 h-full w-full overflow-visible">
      <defs>
        <filter id={`${id}-glow`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>
      <path ref={base} fill="none" stroke={color} strokeOpacity={0.14} strokeWidth={1.5} />
      <path ref={trail} fill="none" stroke={color} strokeWidth={2.5} strokeLinecap="round" strokeOpacity={0.9} />
      <circle ref={head} r={6} fill={color} opacity={0.45} filter={`url(#${id}-glow)`} />
      <circle ref={core} r={2.4} fill="#fff" opacity={0.95}>
        <animate attributeName="r" values="2.2;2.8;2.2" dur="0.9s" repeatCount="indefinite" />
      </circle>
    </svg>
  );
}
