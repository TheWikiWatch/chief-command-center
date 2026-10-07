"use client";

import { motion } from "motion/react";
import type { KeyboardEvent, ReactNode } from "react";

import { SPRING } from "@/lib/motion";

export type Surface = "fleet" | "today" | "vault";

const SURFACES: { id: Surface; label: string }[] = [
  { id: "fleet", label: "Fleet" },
  { id: "today", label: "Today" },
  { id: "vault", label: "Vault" },
];

export const surfaceTabId = (id: Surface) => `surface-tab-${id}`;
export const surfacePanelId = (id: Surface) => `surface-panel-${id}`;

/**
 * Desktop left-pane switch: a segmented control with a sliding pill, as real tabs. Only the chosen tab is in the
 * Tab order; Left/Right (and Home/End) move between them, and each tab names the panel it shows.
 */
export function SurfaceTabs({
  surface,
  onChange,
  trailing,
}: {
  surface: Surface;
  onChange: (next: Surface) => void;
  trailing?: ReactNode;
}) {
  const keys = (e: KeyboardEvent<HTMLButtonElement>) => {
    const at = SURFACES.findIndex((s) => s.id === surface);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (at + 1) % SURFACES.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (at - 1 + SURFACES.length) % SURFACES.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = SURFACES.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(SURFACES[next].id);
    e.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div className="flex w-full items-center gap-3">
      <div className="glass flex gap-0.5 rounded-full p-1" role="tablist" aria-label="Left surface">
        {SURFACES.map(({ id, label }) => {
          const on = surface === id;
          return (
            <button
              key={id}
              id={surfaceTabId(id)}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={surfacePanelId(id)}
              tabIndex={on ? 0 : -1}
              onKeyDown={keys}
              className={`press relative min-h-9 rounded-full px-4 text-callout font-medium transition-colors duration-fast ${
                on ? "text-fg" : "text-fg-3 hover:text-fg-2"
              }`}
              onClick={() => onChange(id)}
            >
              {on ? <motion.span layoutId="surface-pill" className="absolute inset-0 rounded-full bg-fill-3" transition={SPRING.snappy} /> : null}
              <span className="relative">{label}</span>
            </button>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}
