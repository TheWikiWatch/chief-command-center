"use client";

import { motion } from "motion/react";
import { useId } from "react";

import { SPRING } from "@/lib/motion";

/** An on/off switch (Settings, routines). */
export function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition-colors duration-base disabled:cursor-not-allowed ${
        checked ? "justify-end bg-accent-solid" : "justify-start bg-white/[0.14]"
      }`}
    >
      <motion.span
        layout
        transition={SPRING.snappy}
        className="block size-6 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.4)]"
      />
    </button>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (next: T) => void;
}) {
  const id = useId();
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-full bg-well p-1">
      {options.map(([key, text]) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(key)}
            className={`relative min-h-9 flex-1 rounded-full px-2 text-callout font-medium transition-colors duration-fast ${
              active ? "text-fg" : "text-fg-3 hover:text-fg-2"
            }`}
          >
            {active ? (
              <motion.span
                layoutId={`seg-${id}`}
                transition={SPRING.snappy}
                className="absolute inset-0 rounded-full bg-raised shadow-[0_1px_2px_rgb(0_0_0/0.35),inset_0_0_0_1px_var(--line-2)]"
              />
            ) : null}
            <span className="relative">{text}</span>
          </button>
        );
      })}
    </div>
  );
}
