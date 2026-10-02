"use client";

import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { readLevel } from "@/lib/audio-level";
import { motionReducedNow, SPRING } from "@/lib/motion";

const BARS = 44;

/**
 * Takes over the composer while you hold to talk (VISUAL-OVERHAUL §3.2): live waveform of your
 * voice, elapsed time and the cancel hint. Visual only; the mic button underneath owns the gesture.
 */
export function RecordingBar({ cancelling, dragX }: { cancelling: boolean; dragX: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [started] = useState(() => Date.now());
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const t = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);
    return () => window.clearInterval(t);
  }, [started]);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const g = el.getContext("2d");
    if (!g) return;
    const history: number[] = new Array(BARS).fill(0);
    const reduced = motionReducedNow();
    let raf = 0;
    let last = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 33) return; // 30fps is plenty for a waveform
      last = now;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.round(w * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      history.push(readLevel("mic"));
      history.shift();
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const gap = 3;
      const bw = Math.max(2, (w - gap * (BARS - 1)) / BARS);
      const color = getComputedStyle(el).color;
      for (let i = 0; i < BARS; i++) {
        const lvl = reduced ? history[BARS - 1] : history[i];
        const bh = Math.max(3, lvl * (h - 4));
        const x = i * (bw + gap);
        g.globalAlpha = 0.35 + 0.65 * (i / BARS);
        g.fillStyle = color;
        const r = Math.min(bw / 2, 2);
        const y = (h - bh) / 2;
        g.beginPath();
        g.roundRect(x, y, bw, bh, r);
        g.fill();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const mm = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <motion.div
      className={`pointer-events-none absolute inset-y-0 left-0 right-13 z-10 flex items-center gap-3 rounded-full border px-4 ${
        cancelling ? "border-danger/40 bg-danger/10" : "border-accent/30 bg-raised"
      }`}
      initial={{ opacity: 0, scaleX: 0.92 }}
      animate={{ opacity: 1, scaleX: 1, transition: SPRING.snappy }}
      exit={{ opacity: 0, scaleX: 0.96, transition: { duration: 0.14 } }}
      style={{ originX: 1 }}
      role="status"
      aria-live="polite"
    >
      <span className="relative flex h-2.5 w-2.5 shrink-0">
        <span className={`absolute inset-0 animate-ping rounded-full opacity-70 ${cancelling ? "bg-danger" : "bg-accent"}`} />
        <span className={`relative h-2.5 w-2.5 rounded-full ${cancelling ? "bg-danger" : "bg-accent"}`} />
      </span>
      <span className="w-10 shrink-0 font-mono text-code tabular text-fg">{mm}:{ss}</span>
      <motion.canvas
        ref={canvas}
        className={`h-7 min-w-0 flex-1 ${cancelling ? "text-danger" : "text-accent"}`}
        animate={{ x: Math.max(-40, Math.min(0, dragX * 0.25)) }}
        transition={SPRING.snappy}
        aria-hidden="true"
      />
      <span className={`shrink-0 text-caption font-medium ${cancelling ? "text-danger" : "text-fg-3"}`}>
        {cancelling ? "Release to cancel" : "Slide away to cancel"}
      </span>
    </motion.div>
  );
}
