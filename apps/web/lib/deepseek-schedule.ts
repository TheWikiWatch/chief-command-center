/**
 * DeepSeek official peak windows, from https://api-docs.deepseek.com/quick_start/pricing (checked 2026-10-12):
 * "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays.
 * All other hours are off-peak, including weekends and Chinese public holidays in full." Peak costs twice off-peak.
 *
 * In Beijing those windows are 09:00–12:00 and 14:00–18:00, so a window never crosses a Beijing (or UTC) midnight:
 * the weekday and the holiday are the same whichever calendar asks. In US Eastern time they are the evening before
 * (21:00–24:00 EDT) and the early morning (02:00–06:00 EDT), an hour earlier in winter: they look odd from here,
 * which is why the app always says when they are in local time and why it's off-peak when it is.
 *
 * Holidays are Asia/Shanghai civil dates from 国办发明电〔2025〕7号 (2026 only). The 2027 schedule is published
 * around November: add it to HOLIDAYS before 2027 (docs/FRAGILE_SEAMS.md). Make-up workdays on weekends don't
 * matter: DeepSeek counts every weekend day as off-peak.
 */

export type SchedulePhase = "peak" | "off-peak";
export type ScheduleCheck = "match" | "changed" | "unverified";
export type PeakWindow = { start: Date; end: Date };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** UTC hours: [start, end). */
const PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
];

/** Inclusive ranges, YYYY-MM-DD in Asia/Shanghai, with the holiday's name. */
const HOLIDAYS: ReadonlyArray<readonly [string, string, string]> = [
  ["2026-01-01", "2026-01-03", "New Year"],
  ["2026-02-15", "2026-02-23", "Spring Festival"],
  ["2026-04-04", "2026-04-06", "Qingming"],
  ["2026-05-01", "2026-05-05", "Labour Day"],
  ["2026-06-19", "2026-06-21", "Dragon Boat Festival"],
  ["2026-09-25", "2026-09-27", "Mid-Autumn Festival"],
  ["2026-10-01", "2026-10-07", "National Day (Golden Week)"],
];
const HOLIDAY_YEARS = new Set(HOLIDAYS.map(([start]) => start.slice(0, 4)));

const shanghaiDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

export function shanghaiCivilDate(now: Date): string {
  return shanghaiDate.format(now);
}

/** The Chinese public holiday on this Beijing date, if any. */
export function holidayOn(now: Date): string | null {
  const civil = shanghaiCivilDate(now);
  return HOLIDAYS.find(([start, end]) => civil >= start && civil <= end)?.[2] ?? null;
}

/** Whether the holiday dates on file cover this date's year. */
export function holidaysKnown(now: Date): boolean {
  return HOLIDAY_YEARS.has(shanghaiCivilDate(now).slice(0, 4));
}

/** Peak windows that start on this UTC day (none on a weekend or holiday). */
function windowsOnUtcDay(dayStart: number): PeakWindow[] {
  const weekday = new Date(dayStart).getUTCDay();
  if (weekday === 0 || weekday === 6) return [];
  // 04:00 UTC is midday in Beijing: the same Beijing date as both windows.
  if (holidayOn(new Date(dayStart + 4 * HOUR))) return [];
  return PEAK_WINDOWS.map(([a, b]) => ({ start: new Date(dayStart + a * HOUR), end: new Date(dayStart + b * HOUR) }));
}

/** Every peak window that overlaps [from, from + days). */
export function peakWindows(from: Date, days = 7): PeakWindow[] {
  const first = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const until = from.getTime() + days * DAY;
  const out: PeakWindow[] = [];
  for (let t = first; t < until; t += DAY) {
    for (const w of windowsOnUtcDay(t)) if (w.end.getTime() > from.getTime() && w.start.getTime() < until) out.push(w);
  }
  return out;
}

/** The current peak window, if it's peak now. */
export function currentPeak(now: Date): PeakWindow | null {
  const t = now.getTime();
  return peakWindows(new Date(t - DAY), 2).find((w) => w.start.getTime() <= t && t < w.end.getTime()) ?? null;
}

export function deepseekPhase(now: Date): SchedulePhase {
  return currentPeak(now) ? "peak" : "off-peak";
}

/** When the phase next flips (the end of this peak, or the start of the next), or null if none within two weeks. */
export function nextScheduleChange(now: Date): Date | null {
  const peak = currentPeak(now);
  if (peak) return peak.end;
  return peakWindows(now, 14).find((w) => w.start.getTime() > now.getTime())?.start ?? null;
}

/** Why it's off-peak right now, in the owner's words. */
export function offPeakReason(now: Date): string {
  // Beijing's date, which is already "tomorrow" there during an evening here.
  const holiday = holidayOn(now);
  if (holiday) return `Chinese public holiday: ${holiday}`;
  const beijingDay = new Date(`${shanghaiCivilDate(now)}T12:00:00Z`).getUTCDay();
  if (beijingDay === 0 || beijingDay === 6) return "Weekend in China";
  return "Outside DeepSeek's peak hours";
}

/** "9 PM", "9:30 PM" or "midnight": no minutes on the hour. */
export function shortTime(when: Date): string {
  if (when.getHours() === 0 && when.getMinutes() === 0) return "midnight";
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(when).replace(/:00(?=\s?[AaPp]\.?[Mm]|$)/, "");
}

export function formatScheduleWhen(when: Date, now: Date): string {
  const time = shortTime(when);
  if (when.toDateString() === now.toDateString()) return time;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  // A peak that ends at midnight ends "at midnight", not "tomorrow 12 AM".
  if (when.toDateString() === tomorrow.toDateString()) return time === "midnight" ? time : `tomorrow ${time}`;
  return `${new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(when)} ${time}`;
}

/** The owner's time zone by name ("Eastern Daylight Time"), for the schedule's heading. */
export function localZoneName(now: Date): string {
  const part = new Intl.DateTimeFormat(undefined, { timeZoneName: "long" }).formatToParts(now).find((p) => p.type === "timeZoneName");
  return part?.value ?? "your time";
}

/** Peak windows ahead, grouped by the local day they start on: [{ day: "Mon, Oct 12", windows: ["9 PM – 12 AM"] }]. */
export function localWeek(now: Date, days = 7): { day: string; windows: string[]; today: boolean; now: boolean }[] {
  const groups = new Map<string, { day: string; windows: string[]; today: boolean; now: boolean }>();
  const t = now.getTime();
  for (const w of peakWindows(now, days)) {
    const key = w.start.toDateString();
    const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(w.start);
    const group = groups.get(key) ?? { day, windows: [], today: key === now.toDateString(), now: false };
    group.windows.push(`${shortTime(w.start)} – ${shortTime(w.end)}`);
    if (w.start.getTime() <= t && t < w.end.getTime()) group.now = true;
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function scheduleCopy(now: Date, check: ScheduleCheck = "unverified"): { text: string; detail: string; phase: SchedulePhase; until: Date | null } {
  const phase = deepseekPhase(now);
  const next = nextScheduleChange(now);
  const when = next ? formatScheduleWhen(next, now) : "";
  const unknownYear = holidaysKnown(now) ? "" : " Chinese holiday dates on file are for 2026 only, so a holiday may show as peak.";
  if (check === "changed") {
    return {
      text: "Schedule changed",
      detail: `DeepSeek's pricing page no longer matches the saved peak windows, so these times may be wrong.${next ? ` By the saved schedule: ${phase === "peak" ? "off-peak" : "peak"} ${when}.` : ""}`,
      phase,
      until: next,
    };
  }
  const verified = check === "match" ? " Matches DeepSeek's pricing page." : "";
  if (phase === "peak") {
    return { text: "Peak", detail: `Peak pricing: DeepSeek charges twice the off-peak rate until ${when}.${verified}${unknownYear}`, phase, until: next };
  }
  return { text: "Off-peak", detail: `Off-peak (half price). ${offPeakReason(now)}.${next ? ` Peak starts ${when}.` : ""}${verified}${unknownYear}`, phase, until: next };
}
