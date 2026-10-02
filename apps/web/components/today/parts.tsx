"use client";

import { animate as animateValue, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { ClockIcon, RefreshCwIcon, TriangleAlertIcon } from "@/components/icons";
import { EASE } from "@/lib/motion";
import { type TodayItem } from "@/lib/ops";
import { StateFace } from "@/components/state-face";

/* Today's pieces: the morning count-up, stat tiles, banners, the outage card and task rows. */

/** First open of the day plays the morning moment once: counts roll up, rows cascade (§3.2). */
export function useMorning(ready: boolean) {
  const [morning, setMorning] = useState(false);
  const decided = useRef(false);
  useEffect(() => {
    if (!ready || decided.current) return;
    decided.current = true;
    const today = new Date().toDateString();
    try {
      if (localStorage.getItem(MORNING_KEY) !== today) {
        localStorage.setItem(MORNING_KEY, today);
        setMorning(true);
      }
    } catch {
      /* no storage: skip the moment */
    }
  }, [ready]);
  return morning;
}

export const MORNING_KEY = "chief-today-morning";

export function CountUp({ value, animate: run }: { value: number | undefined; animate: boolean }) {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = el.current;
    if (!node || value == null) return;
    if (!run) {
      node.textContent = String(value);
      return;
    }
    const controls = animateValue(0, value, {
      duration: 0.8,
      ease: EASE.enter,
      onUpdate: (v) => {
        node.textContent = String(Math.round(v));
      },
    });
    return () => controls.stop();
  }, [value, run]);
  return <span ref={el}>{value == null ? "–" : run ? "0" : value}</span>;
}

export function StatTiles({ open, overdue, waiting, animate: run }: { open?: number; overdue?: number; waiting?: number; animate: boolean }) {
  const tiles = [
    { label: "Open", value: open, tone: "text-fg" },
    { label: "Overdue", value: overdue, tone: overdue ? "text-danger" : "text-fg" },
    { label: "Waiting", value: waiting, tone: waiting ? "text-warn" : "text-fg" },
  ];
  return (
    <div className="grid grid-cols-3 gap-2">
      {tiles.map((t, i) => (
        <motion.div
          key={t.label}
          className="rounded-card border border-line bg-card px-3.5 py-3"
          initial={run ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0, transition: { delay: run ? i * 0.06 : 0, duration: 0.35, ease: EASE.enter } }}
        >
          <div className="text-caption font-medium text-fg-3">{t.label}</div>
          <div className={`mt-0.5 font-mono text-[1.625rem] font-medium leading-8 tabular ${t.tone}`}>
            <CountUp value={t.value} animate={run} />
          </div>
        </motion.div>
      ))}
    </div>
  );
}

export function Banner({ tone, children }: { tone: "danger" | "warn" | "neutral"; children: React.ReactNode }) {
  const cls = tone === "danger" ? "border-danger/30 bg-danger/8 text-fg" : tone === "warn" ? "border-warn/30 bg-warn/8 text-fg" : "border-line bg-card text-fg-2";
  const Icon = tone === "neutral" ? ClockIcon : TriangleAlertIcon;
  return (
    <p className={`mb-3 flex items-start gap-2.5 rounded-card border px-3.5 py-2.5 text-callout ${cls}`}>
      <Icon size={16} className={`mt-0.5 shrink-0 ${tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-fg-3"}`} />
      <span>{children}</span>
    </p>
  );
}

export function OpsDown({ builtin, error, onRetry }: { builtin: boolean; error: string | null; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <StateFace mood="asleep" size={64} />
      <h2 className="mt-5 text-title text-fg">Your vault is out of reach</h2>
      <p className="mt-2 max-w-xs text-body text-fg-3">
        {builtin ? "Today reads tasks from your Second Brain folder, and it couldn't be read." : "Today reads tasks through your task service, and it isn't answering."}
      </p>
      {error ? <p className="mt-2 max-w-xs text-caption text-fg-3">{error}</p> : null}
      <button type="button" className="press mt-6 flex min-h-11 items-center gap-2 rounded-full border border-line-2 bg-card px-5 text-callout font-medium text-fg hover:border-line-3" onClick={onRetry}>
        <RefreshCwIcon size={16} />
        Try again
      </button>
    </div>
  );
}

export function UrgencyPill({ item }: { item: TodayItem }) {
  const label = item.when_label;
  if (!label) return null;
  const lower = label.toLowerCase();
  const waiting = lower.includes("waiting");
  const cls =
    item.urgency === "hot"
      ? waiting
        ? "bg-warn/15 text-warn"
        : "bg-danger/15 text-danger"
      : item.urgency === "soon" || waiting
        ? "bg-warn/15 text-warn"
        : lower.includes("today")
          ? "bg-accent/15 text-accent-text"
          : "text-fg-3";
  const pill = cls !== "text-fg-3";
  return <span className={`shrink-0 whitespace-nowrap text-caption font-medium ${pill ? `rounded-full px-2 py-0.5 ${cls}` : cls}`}>{label}</span>;
}

export function TaskRow({ item, rank, selected, onClick }: { item: TodayItem; rank: number; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`press grid w-full grid-cols-[1.75rem_minmax(0,1fr)] items-start gap-2 px-3.5 py-3 text-left hover:bg-fill-1 ${selected ? "bg-fill-2" : ""}`}
      onClick={onClick}
    >
      <span className="pt-px font-mono text-callout tabular text-fg-3">{String(rank).padStart(2, "0")}</span>
      <span className="min-w-0">
        <span className="line-clamp-2 text-body font-medium text-fg">{item.text}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="flex items-center gap-1.5 text-caption text-fg-3">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />
            {item.ui_label}
          </span>
          <UrgencyPill item={item} />
        </span>
      </span>
    </button>
  );
}
