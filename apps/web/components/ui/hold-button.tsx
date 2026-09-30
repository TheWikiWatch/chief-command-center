"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Press-and-hold to confirm (VISUAL-OVERHAUL §3.2). A radial fill runs while held;
 * releasing early cancels. Keyboard: hold Space or Enter.
 */
export function HoldButton({
  duration = 900,
  onConfirm,
  onHoldStart,
  disabled,
  className = "",
  children,
  holdingLabel,
  ariaLabel,
}: {
  duration?: number;
  onConfirm: () => void;
  onHoldStart?: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  holdingLabel?: ReactNode;
  ariaLabel: string;
}) {
  const [holding, setHolding] = useState(false);
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fill = useRef<HTMLSpanElement>(null);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  useEffect(() => () => clearTimeout(timer.current), []);

  function start() {
    if (disabled || holding) return;
    setHolding(true);
    setDone(false);
    onHoldStart?.();
    const el = fill.current;
    if (el) {
      el.style.transition = "none";
      el.style.setProperty("--hold", "0");
      void el.offsetWidth;
      el.style.transition = `--hold ${duration}ms linear`;
      el.style.setProperty("--hold", "1");
    }
    timer.current = setTimeout(() => {
      setHolding(false);
      setDone(true);
      confirmRef.current();
    }, duration);
  }

  function cancel() {
    if (!holding) return;
    clearTimeout(timer.current);
    setHolding(false);
    const el = fill.current;
    if (el) {
      el.style.transition = "--hold 220ms cubic-bezier(0.22, 1, 0.36, 1)";
      el.style.setProperty("--hold", "0");
    }
  }

  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={ariaLabel}
      aria-describedby={undefined}
      className={`relative overflow-hidden ${className} ${holding ? "scale-[0.97]" : ""}`}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        start();
      }}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") cancel();
      }}
      onClick={(e) => e.preventDefault()}
    >
      <span ref={fill} aria-hidden="true" className="hold-fill pointer-events-none absolute inset-0" />
      <span className="relative">{holding && holdingLabel ? holdingLabel : done ? children : children}</span>
    </button>
  );
}
