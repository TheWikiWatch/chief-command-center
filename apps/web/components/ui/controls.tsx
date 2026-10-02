"use client";

import { motion } from "motion/react";
import { useId, type KeyboardEvent, type ReactNode } from "react";

import { SPRING } from "@/lib/motion";

/**
 * Arrow keys for a radio group (the ARIA radio pattern): Left/Up and Right/Down move the choice, Home/End jump,
 * and focus follows. Only the checked radio is in the Tab order (`tabIndex` from `radioTabIndex`).
 */
function radioKeys<T extends string>(keys: readonly T[], value: T, onChange: (next: T) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const at = keys.indexOf(value);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (at + 1) % keys.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (at - 1 + keys.length) % keys.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = keys.length - 1;
    if (next < 0) return;
    e.preventDefault();
    onChange(keys[next]);
    const radios = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
    radios[next]?.focus();
  };
}

const radioTabIndex = (active: boolean) => (active ? 0 : -1);

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
        checked ? "justify-end bg-accent-solid" : "justify-start bg-fill-4"
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
    <div role="radiogroup" aria-label={label} className="flex rounded-full bg-well p-1" onKeyDown={radioKeys(options.map(([k]) => k), value, onChange)}>
      {options.map(([key, text]) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={radioTabIndex(active)}
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

/**
 * A switch between views of one place (Today's Ranked/Attention, Fleet's Crew/Health): a radio group with
 * arrow keys and a sliding pill. Labels can carry a badge.
 */
export function ViewSwitch<T extends string>({
  label,
  value,
  options,
  onChange,
  glass = false,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, ReactNode])[];
  onChange: (next: T) => void;
  glass?: boolean;
}) {
  const id = useId();
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={`flex shrink-0 rounded-full p-0.5 ${glass ? "glass" : "border border-line-2 bg-canvas/60"}`}
      onKeyDown={radioKeys(options.map(([k]) => k), value, onChange)}
    >
      {options.map(([key, text]) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={radioTabIndex(active)}
            onClick={() => onChange(key)}
            className={`relative min-h-9 rounded-full px-3 text-callout font-medium transition-colors duration-fast ${active ? "text-fg" : "text-fg-3 hover:text-fg-2"}`}
          >
            {active ? <motion.span layoutId={`view-${id}`} className="absolute inset-0 rounded-full bg-fill-3" transition={SPRING.snappy} /> : null}
            <span className="relative inline-flex items-center">{text}</span>
          </button>
        );
      })}
    </div>
  );
}
