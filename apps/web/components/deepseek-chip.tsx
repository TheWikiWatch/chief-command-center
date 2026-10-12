"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { Sheet } from "@/components/ui/sheet";
import { formatScheduleWhen, localWeek, localZoneName, offPeakReason, scheduleCopy, shortTime, type ScheduleCheck } from "@/lib/deepseek-schedule";

/**
 * DeepSeek's peak pricing (lib/deepseek-schedule.ts). The chat header shows `DeepseekChip` only during peak (or when
 * DeepSeek's page no longer matches the saved schedule); tapping it opens the week's peak hours in local time. The
 * status sheet shows `DeepseekSchedule` at all times.
 */

const PHONE = "(max-width: 767px)";
const watchPhone = (onChange: () => void) => {
  const mq = window.matchMedia(PHONE);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
};
const usePhone = () => useSyncExternalStore(watchPhone, () => window.matchMedia(PHONE).matches, () => false);

/** The current time, refreshed exactly when the phase flips, once a minute, and the moment the app is shown again. */
function useScheduleNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const until = scheduleCopy(now).until;
    const flip = until ? window.setTimeout(tick, Math.max(500, until.getTime() - Date.now() + 500)) : undefined;
    const minute = window.setInterval(tick, 60_000);
    const shown = () => document.visibilityState === "visible" && tick();
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("focus", tick);
    window.addEventListener("pageshow", tick);
    return () => {
      window.clearTimeout(flip);
      window.clearInterval(minute);
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("focus", tick);
      window.removeEventListener("pageshow", tick);
    };
  }, [now]);
  return now;
}

/** Whether DeepSeek's pricing page still says what the app assumes (checked by the dashboard server daily). */
function useScheduleCheck(): ScheduleCheck {
  const [check, setCheck] = useState<ScheduleCheck>("unverified");
  useEffect(() => {
    let stop = false;
    const load = () => {
      fetch("/api/deepseek-schedule", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { status?: ScheduleCheck } | null) => {
          if (!stop && (data?.status === "match" || data?.status === "changed" || data?.status === "unverified")) setCheck(data.status);
        })
        .catch(() => undefined);
    };
    load();
    const timer = window.setInterval(load, 60 * 60 * 1000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);
  return check;
}

/**
 * The header chip: shown only during peak. "Peak · 2× until 12 AM" when the name area has room, "2×" when it
 * doesn't (a container query on `@container/name`, set by the chat header), so it never pushes into the thread
 * switcher. Tapping opens the schedule.
 */
export function DeepseekChip() {
  const now = useScheduleNow();
  const check = useScheduleCheck();
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const copy = scheduleCopy(now, check);
  const changed = check === "changed";
  if (copy.phase !== "peak" && !changed) return null;
  const until = copy.until ? shortTime(copy.until) : "";
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`press inline-flex min-w-0 shrink items-center gap-1.5 rounded-full border px-2 py-0.5 text-micro font-medium ${
          changed ? "border-line-2 text-fg-3" : "border-warn/40 bg-warn/10 text-warn"
        }`}
        aria-label={`${copy.detail} Show DeepSeek's peak hours.`}
      >
        <span className={`size-1.5 shrink-0 rounded-full ${changed ? "bg-fg-4" : "bg-warn"}`} aria-hidden />
        {changed ? (
          <span className="truncate">Check schedule</span>
        ) : (
          <>
            <span className="hidden truncate @min-[12rem]/name:inline">Peak · 2× until {until}</span>
            <span className="whitespace-nowrap @min-[12rem]/name:hidden">Peak 2×</span>
          </>
        )}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="DeepSeek pricing" subtitle="Peak and off-peak hours" side={phone ? "bottom" : "center"}>
        <div className="px-4 pb-6">
          <DeepseekSchedule />
        </div>
      </Sheet>
    </>
  );
}

/** The schedule: the state now and why, then the week's peak hours in the owner's time zone. */
export function DeepseekSchedule() {
  const now = useScheduleNow();
  const check = useScheduleCheck();
  const copy = scheduleCopy(now, check);
  const peak = copy.phase === "peak" && check !== "changed";
  const week = localWeek(now);
  const when = copy.until ? formatScheduleWhen(copy.until, now) : "";
  const line =
    check === "changed"
      ? copy.detail
      : peak
        ? `Until ${when}. Off-peak costs half as much, so long jobs can wait.`
        : `${offPeakReason(now)}.${when ? ` Peak starts ${when}.` : ""}`;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2.5">
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${peak ? "bg-warn" : check === "changed" ? "bg-fg-4" : "bg-ok"}`} aria-hidden />
        <div className="min-w-0">
          <p className={`text-body font-medium ${peak ? "text-warn" : "text-fg"}`}>{check === "changed" ? "Schedule changed" : peak ? "Peak: twice the price" : "Off-peak: half price"}</p>
          <p className="mt-0.5 text-callout text-fg-3">{line}</p>
          {check === "match" ? <p className="mt-0.5 text-caption text-fg-4">Matches DeepSeek&apos;s pricing page (checked daily).</p> : null}
        </div>
      </div>
      <div>
        <p className="mb-1.5 text-caption font-medium text-fg-2">Peak hours, next 7 days ({localZoneName(now)})</p>
        {week.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-ctl border border-line">
            {week.map((d) => (
              <li key={d.day} className={`flex items-baseline justify-between gap-3 px-3 py-1.5 text-callout ${d.now ? "bg-warn/5" : ""}`}>
                <span className={d.today ? "font-medium text-fg" : "text-fg-2"}>{d.today ? `Today · ${d.day.split(", ").pop()}` : d.day}</span>
                <span className="text-right font-mono text-code tabular text-fg-2">{d.windows.join(", ")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-callout text-fg-3">No peak hours in the next 7 days.</p>
        )}
        <p className="mt-2 text-caption text-fg-3">Weekends and Chinese public holidays are off-peak all day. DeepSeek publishes the hours in UTC; they are shown here in your time.</p>
      </div>
    </div>
  );
}
