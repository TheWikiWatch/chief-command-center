import { requestJson } from "@/lib/request";

/** Scheduled routines for the chief and every bot (bridge contract chief.routines.v1). */
export type ScheduleKind = "daily" | "weekdays" | "weekly" | "hourly" | "custom";
export type RoutineSchedule = {
  kind: ScheduleKind;
  /** "HH:MM" for daily, weekdays and weekly. */
  time?: string;
  /** 0 = Sunday … 6 = Saturday, for weekly. */
  days?: number[];
  /** Hours between runs, for hourly. */
  every?: number;
  /** A cron expression or Hermes interval, for custom. */
  cron?: string;
  /** The schedule in plain words (read only). */
  text?: string;
};
export type TeamRoutine = {
  id: string;
  /** The profile that runs it: "chief" or a bot's id. */
  profile: string;
  bot: string;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  state: string;
  /** ISO times from Hermes. */
  nextRun: string | null;
  lastRun: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastOutput: string;
  /** The chat thread it reports to; null when it reports nowhere. */
  thread: string | null;
  /** Saved only: no chat thread and nothing sent anywhere else. */
  silent: boolean;
  /** Where Hermes delivers its results, as stored (e.g. "command_center", "telegram:123"). */
  deliver?: string;
  /** Some of its results leave the app (another chat service, every platform). */
  external?: boolean;
  /** A bot made it from a conversation (not the dashboard, not the app). */
  createdByBot?: boolean;
  /** A script it runs, or a URL or script it watches, when it has one. */
  script?: string;
  monitor?: string;
  kind: "agent" | "script";
  /** The app's own (Second Brain, Fleet Health): retime, move and switch off only. */
  builtIn: boolean;
  skills: string[];
  /** The model it runs on: the bot's own when it fires, or pinned to one. */
  model?: { pinned: boolean; model: string; provider: string };
  /** Why it's paused, when it is (e.g. made paused to start later). */
  pausedReason?: string;
  /** "on": failures are reported where its results go; "muted"; "elsewhere": a bot sent them outside the app. */
  failureAlerts?: "on" | "muted" | "elsewhere";
  /** Runs that failed in a row (0 after a good one). */
  failureStreak?: number;
};
export type RoutineBot = { id: string; name: string };
export type RoutineOptions = { paused?: boolean; pin?: boolean; alerts?: "on" | "muted" };
export type RoutineDraft = { profile: string; name: string; prompt: string; schedule: RoutineSchedule; thread: string } & RoutineOptions;

type One = { ok: boolean; error?: string; routine?: TeamRoutine };
const post = <T>(path: string, body: unknown) =>
  requestJson<T>(`/api/bridge/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 20_000);

export const routinesApi = {
  list: () => requestJson<{ ok: boolean; error?: string; routines: TeamRoutine[]; bots: RoutineBot[] }>("/api/bridge/routines", { cache: "no-store" }, 15_000),
  create: (draft: RoutineDraft) => post<One>("routines", draft),
  update: (profile: string, id: string, changes: Partial<Pick<RoutineDraft, "name" | "prompt" | "schedule" | "thread" | "pin" | "alerts">> & { enabled?: boolean }) =>
    post<One>("routines/update", { profile, id, ...changes }),
  run: (profile: string, id: string) => post<One>("routines/run", { profile, id }),
  remove: (profile: string, id: string) => post<{ ok: boolean; error?: string }>("routines/delete", { profile, id }),
};

/** A built-in routine's name without its "Second Brain: " / "Fleet: " prefix, capitalized, and its group. */
export function routineLabel(r: Pick<TeamRoutine, "name" | "builtIn">): { name: string; group: string } {
  const m = r.builtIn ? /^(Second Brain|Fleet): (.*)$/.exec(r.name) : null;
  if (!m) return { name: r.name, group: "" };
  return { name: m[2].charAt(0).toUpperCase() + m[2].slice(1), group: m[1] === "Fleet" ? "Fleet Health" : m[1] };
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Today 07:30", "Tomorrow 07:30", "Fri 07:30" or "12 Oct 07:30". */
export function whenLabel(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  // 24-hour, like the schedules ("Weekdays at 07:30").
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(at) - day(now)) / 86_400_000);
  if (diff === 0) return `Today ${time}`;
  if (diff === 1) return `Tomorrow ${time}`;
  if (diff === -1) return `Yesterday ${time}`;
  if (diff > 1 && diff < 7) return `${DAY_NAMES[at.getDay()]} ${time}`;
  return `${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

/** The last run's outcome in a word, and whether it went wrong. */
export function lastResult(r: Pick<TeamRoutine, "lastRun" | "lastStatus">): { text: string; bad: boolean } | null {
  if (!r.lastRun) return null;
  const status = String(r.lastStatus || "");
  if (!status || status === "ok" || status === "success") return { text: "Ran fine", bad: false };
  if (status.startsWith("blocked")) return { text: "Blocked", bad: true };
  if (status === "delivery_failed") return { text: "Ran, not delivered", bad: true };
  return { text: "Failed", bad: true };
}
