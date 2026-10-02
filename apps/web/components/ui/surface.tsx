"use client";

import type { ReactNode } from "react";

/**
 * Surfaces and states: Card, Banner, EmptyState and Skeleton, so every pane looks the same while loading, when
 * empty and when something needs saying.
 */
export function Card({ children, className = "", as: Tag = "div" }: { children: ReactNode; className?: string; as?: "div" | "section" | "article" | "li" }) {
  return <Tag className={`rounded-card border border-line bg-card ${className}`.trim()}>{children}</Tag>;
}

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

const TONE: Record<Tone, string> = {
  neutral: "border-line-2 bg-fill-1 text-fg-2",
  accent: "border-accent/30 bg-accent/10 text-accent-text",
  ok: "border-ok/30 bg-ok/10 text-ok",
  warn: "border-warn/30 bg-warn/10 text-warn",
  danger: "border-danger/30 bg-danger/10 text-danger",
};

/** A one-line message across a pane. `role="alert"` for danger, `status` otherwise. */
export function Banner({ tone = "neutral", icon, action, children, className = "" }: { tone?: Tone; icon?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex items-start gap-2.5 rounded-ctl border px-3 py-2.5 text-callout ${TONE[tone]} ${className}`.trim()}>
      {icon ? <span className="mt-px shrink-0">{icon}</span> : null}
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** Nothing here yet: a picture (the chief's face, an icon), what this place is for, and what to do next. */
export function EmptyState({ visual, title, children, actions, className = "" }: { visual?: ReactNode; title: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={`mx-auto flex max-w-sm flex-col items-center px-6 py-10 text-center ${className}`.trim()}>
      {visual ? <div className="mb-4">{visual}</div> : null}
      <h3 className="text-headline text-fg">{title}</h3>
      {children ? <div className="mt-1.5 text-body text-fg-3">{children}</div> : null}
      {actions ? <div className="mt-5 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Placeholder shapes while something loads. `lines` draws paragraph-like bars; otherwise one block. */
export function Skeleton({ lines, className = "", label = "Loading" }: { lines?: number; className?: string; label?: string }) {
  if (lines) {
    return (
      <div role="status" aria-label={label} className={`space-y-2.5 ${className}`.trim()}>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className="skeleton h-3.5 rounded-full" style={{ width: `${i === lines - 1 ? 55 : 100 - ((i * 13) % 30)}%` }} />
        ))}
      </div>
    );
  }
  return <div role="status" aria-label={label} className={`skeleton rounded-card ${className}`.trim()} />;
}

/** A value still on its way, inside a line of text (a version number, a folder path). */
export function LoadingLine({ className = "w-28", label = "Loading" }: { className?: string; label?: string }) {
  return <span role="status" aria-label={label} className={`skeleton inline-block h-3 rounded-full align-middle ${className}`.trim()} />;
}

/** A list still loading: row-shaped placeholders. */
export function SkeletonRows({ rows = 4, className = "", label = "Loading" }: { rows?: number; className?: string; label?: string }) {
  return (
    <div role="status" aria-label={label} className={`divide-y divide-(--line-1) ${className}`.trim()}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 py-3.5">
          <div className="skeleton size-6 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="skeleton h-3.5 rounded-full" style={{ width: `${78 - ((i * 17) % 34)}%` }} />
            <div className="skeleton h-2.5 w-24 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
}
