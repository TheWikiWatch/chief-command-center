/**
 * DeepSeek official peak windows, from https://api-docs.deepseek.com/quick_start/pricing
 * Peak: 01:00–04:00 and 06:00–10:00 UTC, Monday–Friday, excluding Chinese public holidays.
 * Ends are exclusive. Weekends and those holidays are off-peak for the full day.
 * Holiday dates are Asia/Shanghai civil dates from 国办发明电〔2025〕7号 (2026 only).
 */

export type SchedulePhase = "peak" | "off-peak";
export type ScheduleCheck = "match" | "changed" | "unverified";

const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [1 * 60, 4 * 60],
  [6 * 60, 10 * 60],
];

/** Inclusive ranges, YYYY-MM-DD in Asia/Shanghai. */
const HOLIDAY_RANGES_2026: ReadonlyArray<readonly [string, string]> = [
  ["2026-01-01", "2026-01-03"],
  ["2026-02-15", "2026-02-23"],
  ["2026-04-04", "2026-04-06"],
  ["2026-05-01", "2026-05-05"],
  ["2026-06-19", "2026-06-21"],
  ["2026-09-25", "2026-09-27"],
  ["2026-10-01", "2026-10-07"],
];

const shanghaiDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function expandRange(start: string, end: string): string[] {
  const days: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor.getTime() <= last.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

const HOLIDAYS_2026 = new Set(HOLIDAY_RANGES_2026.flatMap(([start, end]) => expandRange(start, end)));

export function shanghaiCivilDate(now: Date): string {
  return shanghaiDate.format(now);
}

export function deepseekPhase(now: Date): SchedulePhase {
  const civil = shanghaiCivilDate(now);
  if (civil.startsWith("2026-") && HOLIDAYS_2026.has(civil)) return "off-peak";
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return "off-peak";
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const peak = PEAK_WINDOWS.some(([start, end]) => mins >= start && mins < end);
  return peak ? "peak" : "off-peak";
}

/** Next minute where the phase flips, or null if none within two weeks. */
export function nextScheduleChange(now: Date): Date | null {
  const phase = deepseekPhase(now);
  const start = now.getTime();
  const aligned = start - (start % 60_000) + 60_000;
  const limit = 14 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    const t = new Date(aligned + i * 60_000);
    if (deepseekPhase(t) !== phase) return t;
  }
  return null;
}

export function formatScheduleWhen(when: Date, now: Date): string {
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(when);
  if (when.toDateString() === now.toDateString()) return time;
  const day = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(when);
  return `${day} ${time}`;
}

export function scheduleCopy(now: Date, check: ScheduleCheck = "unverified"): { text: string; detail: string; phase: SchedulePhase } {
  const phase = deepseekPhase(now);
  const next = nextScheduleChange(now);
  const when = next ? formatScheduleWhen(next, now) : "";
  const flip = next ? (phase === "peak" ? `Off-peak at ${when}` : `Peak at ${when}`) : "";
  if (check === "changed") {
    return {
      text: "Schedule changed",
      detail: flip
        ? `DeepSeek's pricing page no longer matches the saved peak windows. ${flip}.`
        : "DeepSeek's pricing page no longer matches the saved peak windows.",
      phase,
    };
  }
  const year = shanghaiCivilDate(now).slice(0, 4);
  const holidayNote = year === "2026" ? "" : " Chinese holiday dates on file are for 2026.";
  const verified = check === "match" ? " Matches DeepSeek's pricing page." : "";
  const lead = phase === "peak" ? "DeepSeek peak" : "DeepSeek off-peak";
  return {
    text: phase === "peak" ? "Peak" : "Off-peak",
    detail: `${lead}.${flip ? ` ${flip}.` : ""}${verified}${holidayNote}`.replace(/\s+/g, " ").trim(),
    phase,
  };
}
