"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

import { SPRING } from "@/lib/motion";

export type Surface = "fleet" | "today" | "vault";

const SURFACES: { id: Surface; label: string }[] = [
  { id: "fleet", label: "Fleet" },
  { id: "today", label: "Today" },
  { id: "vault", label: "Vault" },
];

/** Desktop left-pane switch: a segmented control with a sliding pill. */
export function SurfaceTabs({
  surface,
  onChange,
  trailing,
}: {
  surface: Surface;
  onChange: (next: Surface) => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex w-full items-center gap-3">
      <div className="glass flex gap-0.5 rounded-full p-1" role="tablist" aria-label="Left surface">
        {SURFACES.map(({ id, label }) => {
          const on = surface === id;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={on}
              className={`relative min-h-9 rounded-full px-4 text-callout font-medium transition-colors duration-fast ${
                on ? "text-fg" : "text-fg-3 hover:text-fg-2"
              }`}
              onClick={() => onChange(id)}
            >
              {on ? <motion.span layoutId="surface-pill" className="absolute inset-0 rounded-full bg-white/10" transition={SPRING.snappy} /> : null}
              <span className="relative">{label}</span>
            </button>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}
