"use client";

import { useEffect, useRef } from "react";

import { useFaceClock } from "@/lib/face-clock";
import { useFxPrefs } from "@/lib/fx-prefs";

type Star = { x: number; y: number; z: number; tw: number; hue: number };

function seeded(n: number, seed = 7) {
  let h = seed;
  const rand = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822519) + 0x6d2b79f5;
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
  return Array.from({ length: n }, (): Star => ({ x: rand(), y: rand(), z: rand(), tw: rand() * Math.PI * 2, hue: rand() }));
}

/**
 * Canvas starfield behind the orbits (VISUAL-OVERHAUL §4.4). Twinkles and drifts with the
 * pointer (desktop) or device tilt (Android). Drawn on the shared face clock, so it pauses
 * when hidden and runs at 30fps on the phone. Ambient Off draws one static frame.
 */
export function Starfield({ count = 140, className = "" }: { count?: number; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const stars = useRef<Star[]>(seeded(count));
  const tilt = useRef({ x: 0, y: 0, tx: 0, ty: 0 });
  const { ambient } = useFxPrefs();
  const live = ambient !== "off";

  useEffect(() => {
    if (!live) return;
    const onMove = (e: PointerEvent) => {
      tilt.current.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      tilt.current.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    };
    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.gamma == null || e.beta == null) return;
      tilt.current.tx = Math.max(-1, Math.min(1, e.gamma / 30));
      tilt.current.ty = Math.max(-1, Math.min(1, (e.beta - 45) / 30));
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("deviceorientation", onTilt, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("deviceorientation", onTilt);
    };
  }, [live]);

  const draw = (t: number) => {
    const el = canvas.current;
    if (!el) return;
    const g = el.getContext("2d");
    if (!g) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w || !h) return;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
    }
    const tl = tilt.current;
    tl.x += (tl.tx - tl.x) * 0.05;
    tl.y += (tl.ty - tl.y) * 0.05;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    for (const s of stars.current) {
      const depth = 0.3 + s.z * 0.7;
      const x = ((s.x * w + tl.x * depth * 14 + t * depth * 2.2) % w + w) % w;
      const y = s.y * h + tl.y * depth * 10;
      const twinkle = live ? 0.55 + 0.45 * Math.sin(t * (0.6 + s.z * 1.4) + s.tw) : 0.8;
      const r = 0.35 + depth * 0.9;
      g.globalAlpha = Math.max(0, twinkle) * (0.25 + depth * 0.6);
      g.fillStyle = s.hue > 0.82 ? "#ffd9c7" : s.hue > 0.7 ? "#ffb3b6" : "#f6f1e7";
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
  };

  useFaceClock(canvas, draw, live);
  useEffect(() => {
    if (!live) requestAnimationFrame(() => draw(0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  return <canvas ref={canvas} aria-hidden="true" className={`pointer-events-none absolute inset-0 h-full w-full ${className}`} />;
}
