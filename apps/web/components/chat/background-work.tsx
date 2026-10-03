"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { ChevronDownIcon } from "@/components/icons";
import { DUR, EASE } from "@/lib/motion";
import type { BackgroundUnit } from "@/lib/types";

const OPEN_KEY = "chief.backgroundWork.open";

/** "3:07", "1:02:45": how long the oldest background task has been running. */
export function elapsedLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function backgroundTaskCount(units: BackgroundUnit[]): number {
  return units.reduce((n, u) => n + u.tasks.length, 0);
}

/**
 * Work the chief handed to helpers that is still running after its turn ended (Hermes runs delegated tasks in the
 * background; their results come back later as a message). Without this the chief looked idle while four research
 * lanes ran. A one-line summary that opens to each task's goal and current step; gone when the work is done.
 */
export function BackgroundWork({ units, assistant, color }: { units: BackgroundUnit[]; assistant: string; color?: string }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [now, setNow] = useState(() => Date.now() / 1000);
  const count = backgroundTaskCount(units);
  useEffect(() => {
    if (!count) return undefined;
    const tick = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(tick);
  }, [count]);
  if (!count) return null;
  const since = Math.min(...units.map((u) => u.since || now));
  const toggle = () =>
    setOpen((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? "0" : "1");
      } catch {
        // a private window: the choice just isn't remembered
      }
      return !v;
    });

  return (
    <section aria-label="Background work" className="mb-2 overflow-hidden rounded-card border border-line bg-card/70">
      <button type="button" aria-expanded={open} onClick={toggle} className="press flex min-h-11 w-full items-center gap-2.5 px-3 text-left">
        {/* The chief's own colour: busy, not an alert (the theme's accent is red). */}
        <span aria-hidden className="relative flex size-2 shrink-0" style={{ color: color || "rgb(var(--c-fg-2))" }}>
          <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-50" />
          <span className="relative size-2 rounded-full bg-current" />
        </span>
        <span className="min-w-0 flex-1 truncate text-callout">
          <span className="font-medium text-fg">
            {count} task{count === 1 ? "" : "s"} in the background
          </span>
          <span className="sr-only"> ({assistant} is still working on them)</span>
        </span>
        <span className="shrink-0 font-mono text-caption tabular-nums text-fg-3" aria-label={`running for ${elapsedLabel(now - since)}`}>
          {elapsedLabel(now - since)}
        </span>
        <ChevronDownIcon className={`size-4 shrink-0 text-fg-3 transition-transform duration-fast ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul
            key="tasks"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: { duration: DUR.base, ease: EASE.enter } }}
            exit={{ height: 0, opacity: 0, transition: { duration: DUR.fast, ease: EASE.exit } }}
            className="max-h-[40vh] overflow-y-auto overscroll-contain border-t border-line"
          >
            {units.flatMap((u) =>
              u.tasks.map((t, i) => (
                <li key={`${u.id}-${i}`} className="flex gap-2.5 px-3 py-2.5 [&+&]:border-t [&+&]:border-line/60">
                  <span aria-hidden className={`mt-1.5 size-1.5 shrink-0 rounded-full ${u.status === "stalling" ? "bg-warn" : "bg-fg-3"}`} />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 text-callout text-fg-2">{t.goal || "A task"}</span>
                    <span className={`mt-0.5 block text-caption ${u.status === "stalling" ? "text-warn" : "shimmer-text"}`}>{t.step}</span>
                  </span>
                </li>
              )),
            )}
            <li className="px-3 pb-2.5 pt-1 text-caption text-fg-3">The results come back here as a message when they're done.</li>
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
