"use client";

import { type ReactNode } from "react";
import { RefreshCwIcon } from "@/components/icons";
import { fill, type FleetHealth as Health } from "@/lib/fleet-health";
import { agoAt, agoIso } from "@/components/fleet-health";

/* Fleet Health's building blocks: sections, tiles, refresh, empty states, sparklines and the runtime card. */

export function Section({ title, count, hint, children }: { title: string; count?: number; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <div className="mb-2 flex items-baseline gap-2 px-1">
        <h2 className="text-headline text-fg">{title}</h2>
        {count != null ? <span className="font-mono text-code tabular text-fg-3">{count}</span> : null}
        {hint ? <span className="ml-auto truncate text-caption text-fg-3">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

export function Tile({ label, value, note, tone }: { label: string; value: number; note?: string; tone?: "danger" | "warn" }) {
  const color = tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-fg";
  return (
    <div className="rounded-card border border-line bg-card px-3.5 py-3">
      <div className="truncate text-caption font-medium text-fg-3">{label}</div>
      <div className={`mt-0.5 font-mono text-[1.5rem] font-medium leading-8 tabular ${color}`}>{value}</div>
      {note ? <div className="truncate text-caption text-fg-3">{note}</div> : null}
    </div>
  );
}

export function RefreshButton({ busy, onClick, label, small = false }: { busy: boolean; onClick: () => void; label: string; small?: boolean }) {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`press inline-flex items-center gap-1.5 rounded-full border border-line-2 text-fg-2 hover:border-line-3 hover:text-fg disabled:opacity-60 ${small ? "min-h-8 px-2.5 text-caption" : "min-h-11 px-4 text-callout font-medium"}`}
    >
      <RefreshCwIcon size={small ? 13 : 15} className={busy ? "animate-spin" : undefined} />
      {busy ? "Running…" : label}
    </button>
  );
}

export function Sparkline({ weeks }: { weeks: number[] }) {
  const max = Math.max(1, ...weeks);
  const w = 6;
  const gap = 3;
  return (
    <svg width={weeks.length * (w + gap) - gap} height={20} aria-hidden="true" className="shrink-0">
      {weeks.map((n, i) => {
        const h = n ? Math.max(3, Math.round((n / max) * 20)) : 2;
        return <rect key={i} x={i * (w + gap)} y={20 - h} width={w} height={h} rx={1.5} className={i === weeks.length - 1 ? "fill-accent" : n ? "fill-fg-3" : "fill-white/10"} />;
      })}
    </svg>
  );
}

export function MemoryBar({ used, limit, label }: { used: number; limit: number; label: string }) {
  const f = fill(used, limit);
  const tone = f >= 1 ? "bg-danger" : f >= 0.9 ? "bg-warn" : "bg-fg-3";
  return (
    <div className="flex items-center gap-2" title={`${label}: ${used} of ${limit} characters`}>
      <span className="w-12 text-caption text-fg-3">{label}</span>
      <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-fill-2">
        <span className={`absolute inset-y-0 left-0 rounded-full ${tone}`} style={{ width: `${Math.round(f * 100)}%` }} />
      </span>
      <span className={`w-9 text-right font-mono text-caption tabular ${f >= 0.9 ? "text-warn" : "text-fg-3"}`}>{Math.round(f * 100)}%</span>
    </div>
  );
}

export function RunCell({ label, value, bad = false }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="border-b border-line px-3.5 py-2 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <dt className="text-fg-3">{label}</dt>
      <dd className={bad ? "text-warn" : "text-fg-2"}>{value}</dd>
    </div>
  );
}

export function RuntimeCard({ health }: { health: Health }) {
  const rt = health.runtime;
  return (
    <div className="rounded-card border border-line bg-card">
      <div className="px-3.5 py-3">
        <p className="text-callout text-fg">
          {rt.crashes7d ? (
            <>
              <span className={rt.crashes24h ? "font-semibold text-danger" : "font-semibold"}>{rt.crashes24h}</span> crashes in 24h ·{" "}
              <span className="font-semibold">{rt.crashes7d}</span> in 7 days · last {agoAt(rt.lastCrashAt)}
            </>
          ) : (
            "No native crashes in 7 days."
          )}
        </p>
        {rt.crashGroups.length ? (
          <ul className="mt-2 space-y-1">
            {rt.crashGroups.map((g) => (
              <li key={g.key} className="flex items-baseline gap-2 text-caption">
                <span className="w-9 shrink-0 text-right font-mono tabular text-fg-2">{g.count}×</span>
                <span className="truncate font-mono text-fg-3">{g.key}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <dl className="grid grid-cols-1 border-t border-line text-caption sm:grid-cols-3">
        <RunCell label="Weekly distill" value={agoIso(rt.distill?.lastRunAt)} bad={rt.distill?.lastStatus !== "ok" && !!rt.distill?.lastRunAt} />
        <RunCell label="Roster review" value={agoIso(rt.rosterReview?.lastRunAt)} />
        <RunCell label="Skill curator" value={rt.curator ? rt.curator.at.replace(/^(\d{4})(\d{2})(\d{2})-.*/, "$1-$2-$3") : "never"} />
      </dl>
    </div>
  );
}
