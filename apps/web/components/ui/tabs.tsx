"use client";

import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type { ReactNode } from "react";

/**
 * Tabs with the full keyboard pattern (arrow keys move between tabs, Home/End jump, each tab controls its
 * panel), on Base UI. `SegmentedTabs` is the pill look the app uses for view switches (Ranked/Attention,
 * Crew/Health); the sliding pill is Base UI's indicator.
 */
export function SegmentedTabs<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "sm",
  className = "",
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly (readonly [T, ReactNode])[];
  label: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const height = size === "md" ? "min-h-10" : "min-h-8";
  return (
    <BaseTabs.Root value={value} onValueChange={(next) => onChange(next as T)}>
      <BaseTabs.List aria-label={label} className={`relative inline-flex items-center gap-0.5 rounded-full border border-line-2 bg-canvas/60 p-1 ${className}`.trim()}>
        {options.map(([id, text]) => (
          <BaseTabs.Tab
            key={id}
            value={id}
            className={`press relative z-10 ${height} rounded-full px-3 text-callout text-fg-3 transition-colors duration-fast hover:text-fg data-active:font-semibold data-active:text-fg`}
          >
            {text}
          </BaseTabs.Tab>
        ))}
        <BaseTabs.Indicator className="absolute left-0 top-1/2 z-0 h-(--active-tab-height) w-(--active-tab-width) -translate-y-1/2 translate-x-(--active-tab-left) rounded-full bg-fill-3 transition-[translate,width] duration-base ease-enter" />
      </BaseTabs.List>
    </BaseTabs.Root>
  );
}
