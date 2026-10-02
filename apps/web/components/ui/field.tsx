"use client";

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

/**
 * Text fields. Focus is a 2 px accent ring (it used to be a border going from 10 % to 16 % white, which met no
 * contrast rule). `field()` gives the class string; `Input`, `Textarea` and `Select` the elements; `Field` a
 * label, hint and error wired to its control.
 */
export function field(opts: { mono?: boolean; extra?: string } = {}): string {
  const type = opts.mono ? "font-mono text-code" : "text-body";
  return `min-h-11 rounded-ctl border border-line-2 bg-canvas px-3 text-fg placeholder:text-fg-3 outline-hidden transition-[border-color,box-shadow] duration-fast hover:border-line-3 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/35 disabled:opacity-60 aria-invalid:border-danger ${type} ${opts.extra || ""}`.trim();
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input({ mono, className = "", ...rest }, ref) {
  return <input ref={ref} className={field({ mono, extra: className })} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }>(function Textarea({ mono, className = "", ...rest }, ref) {
  return <textarea ref={ref} className={field({ mono, extra: `py-2 ${className}` })} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className = "", ...rest }, ref) {
  return <select ref={ref} className={field({ extra: `pr-8 ${className}` })} {...rest} />;
});

/** A labelled control: `children` receives the id to put on the control, and the ids that describe it. */
export function Field({
  label,
  hint,
  error,
  children,
  className = "",
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`space-y-1.5 ${className}`}>
      <label htmlFor={id} className="block text-callout text-fg-2">
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint ? (
        <p id={hintId} className="text-caption text-fg-3">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
