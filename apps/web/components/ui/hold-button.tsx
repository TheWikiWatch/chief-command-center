"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Press-and-hold to confirm (VISUAL-OVERHAUL §3.2). A radial fill runs while held;
 * releasing early cancels. Keyboard: hold Space or Enter.
 *
 * A click that no pointer or key held (`detail` 0: a screen reader's browse mode, voice control) can't hold: the button
 * asks in place instead, as `confirmLabel` (with `armedClassName`), and a second click confirms. Moving away cancels.
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
  confirmLabel = "Confirm",
  armedClassName = "",
}: {
  duration?: number;
  onConfirm: () => void;
  onHoldStart?: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
  holdingLabel?: ReactNode;
  ariaLabel: string;
  confirmLabel?: string;
  armedClassName?: string;
}) {
  const [holding, setHolding] = useState(false);
  const [done, setDone] = useState(false);
  const [asking, setAsking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fill = useRef<HTMLSpanElement>(null);
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  useEffect(() => () => clearTimeout(timer.current), []);

  function start() {
    if (disabled || holding) return;
    setHolding(true);
    setDone(false);
    setAsking(false);
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
    <>
      <button
        type="button"
        disabled={disabled}
        aria-label={asking ? confirmLabel : ariaLabel}
        aria-describedby={undefined}
        className={`relative overflow-hidden ${className} ${asking ? armedClassName : ""} ${holding ? "scale-[0.97]" : ""}`}
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
        onClick={(e) => {
          e.preventDefault();
          // A pointer's or a key's own click comes after its hold, which already decided.
          if (e.detail !== 0 || disabled) return;
          if (!asking) {
            setAsking(true);
            return;
          }
          setAsking(false);
          setDone(true);
          confirmRef.current();
        }}
        onBlur={() => setAsking(false)}
      >
        <span ref={fill} aria-hidden="true" className="hold-fill pointer-events-none absolute inset-0" />
        <span className="relative">{asking ? confirmLabel : holding && holdingLabel ? holdingLabel : done ? children : children}</span>
      </button>
      <span role="status" className="sr-only">
        {asking ? "Press it again to confirm." : ""}
      </span>
    </>
  );
}
