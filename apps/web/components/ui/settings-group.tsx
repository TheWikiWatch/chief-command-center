"use client";

import { useId, type ReactNode } from "react";

/** A Settings section: icon, title, an optional action and hint, then its rows in one card. */
export function Group({
  icon,
  title,
  hint,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="text-fg-3">{icon}</span>
        <h3 id={id} className="min-w-0 flex-1 text-headline text-fg">
          {title}
        </h3>
        {action}
      </div>
      {hint ? <p className="-mt-1 mb-2.5 px-1 text-caption text-fg-3">{hint}</p> : null}
      <div className="divide-y divide-(--line-1) overflow-hidden rounded-card border border-line bg-card">{children}</div>
    </section>
  );
}

export function Row({
  label,
  hint,
  stacked,
  dim,
  children,
}: {
  label: ReactNode;
  hint?: string;
  stacked?: boolean;
  dim?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`px-3.5 py-3 transition-opacity duration-fast ${dim ? "opacity-45" : ""}`}>
      <div className={stacked ? "mb-2" : ""}>
        <p className="text-body text-fg">{label}</p>
        {hint ? <p className="mt-0.5 text-caption text-fg-3">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** The small pill used for a group's action ("Change", "History"). */
export function PillButton({ children, onClick, disabled, label }: { children: ReactNode; onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="press min-h-9 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg disabled:opacity-50"
    >
      {children}
    </button>
  );
}
