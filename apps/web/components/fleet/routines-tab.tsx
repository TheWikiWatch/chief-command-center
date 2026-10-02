"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useId, useState, type ReactNode } from "react";

import { BotFace, faceProps } from "@/components/bot-face";
import { ChevronLeftIcon, ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, PlusIcon } from "@/components/icons";
import { Segmented, Switch } from "@/components/ui/controls";
import { useAssistantName } from "@/lib/identity";
import { EASE } from "@/lib/motion";
import {
  DAY_NAMES,
  lastResult,
  routineLabel,
  routinesApi,
  whenLabel,
  type RoutineBot,
  type RoutineSchedule,
  type ScheduleKind,
  type TeamRoutine,
} from "@/lib/routines-client";
import { threadsApi, type ChatThread } from "@/lib/threads-client";
import type { Person } from "@/lib/types";

type View = { mode: "list" } | { mode: "new" } | { mode: "edit"; id: string; profile: string };
type Note = { tone: "ok" | "error"; text: string };

/**
 * Team & Routines → Routines: every scheduled routine, for the chief and every bot. A routine runs as the bot
 * that owns it and reports into a chat thread. The app's own routines (Second Brain, Fleet Health) can be
 * retimed, moved and switched off, not rewritten or deleted.
 */
export function RoutinesTab({ people }: { people: Person[] }) {
  const assistant = useAssistantName();
  const [routines, setRoutines] = useState<TeamRoutine[] | null>(null);
  const [bots, setBots] = useState<RoutineBot[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [view, setView] = useState<View>({ mode: "list" });
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<Note | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await routinesApi.list();
      if (!res.ok) throw new Error(res.error || "Couldn't read the routines.");
      setRoutines(res.routines);
      setBots(res.bots);
    } catch (e) {
      setNote({ tone: "error", text: e instanceof Error ? e.message : "Couldn't read the routines." });
      setRoutines((r) => r ?? []);
    }
  }, []);
  useEffect(() => {
    void load();
    threadsApi
      .list()
      .then((r) => r.ok && setThreads(r.threads.filter((t) => !t.archived)))
      .catch(() => undefined);
  }, [load]);

  const personFor = useCallback((profile: string) => (profile === "chief" ? people.find((p) => p.isChief) : people.find((p) => p.id === profile)), [people]);

  async function toggle(r: TeamRoutine, on: boolean) {
    setBusy(r.id);
    setNote(null);
    // Optimistic: the switch moves at once and goes back if the bridge refuses.
    setRoutines((list) => list?.map((x) => (x.id === r.id ? { ...x, enabled: on } : x)) ?? null);
    try {
      const res = await routinesApi.update(r.profile, r.id, { enabled: on });
      if (!res.ok) throw new Error(res.error || "That didn't save.");
      if (res.routine) setRoutines((list) => list?.map((x) => (x.id === r.id ? res.routine! : x)) ?? null);
    } catch (e) {
      setRoutines((list) => list?.map((x) => (x.id === r.id ? { ...x, enabled: !on } : x)) ?? null);
      setNote({ tone: "error", text: e instanceof Error ? e.message : "That didn't save." });
    } finally {
      setBusy("");
    }
  }

  const editing = view.mode === "edit" ? routines?.find((r) => r.id === view.id && r.profile === view.profile) : undefined;
  const mine = (routines || []).filter((r) => !r.builtIn);
  const builtIn = (routines || []).filter((r) => r.builtIn);

  return (
    <AnimatePresence mode="wait" initial={false}>
      {view.mode === "list" ? (
        <motion.div
          key="list"
          initial={{ x: -24, opacity: 0 }}
          animate={{ x: 0, opacity: 1, transition: { duration: 0.2, ease: EASE.enter } }}
          exit={{ x: -24, opacity: 0, transition: { duration: 0.12 } }}
          className="space-y-6 px-4 pb-10 pt-3"
        >
          <div className="flex items-start gap-3">
            <p className="min-w-0 flex-1 text-callout text-fg-3">Scheduled work for {assistant} and the team. Each routine runs as the bot you pick and reports into a chat thread.</p>
            <button
              type="button"
              onClick={() => {
                setNote(null);
                setView({ mode: "new" });
              }}
              className="press flex min-h-10 shrink-0 items-center gap-1.5 rounded-full bg-fg px-3.5 text-callout font-semibold text-canvas"
            >
              <PlusIcon size={15} />
              New routine
            </button>
          </div>
          {note ? <NoteLine note={note} /> : null}
          {routines === null ? <p className="text-callout text-fg-3">Reading the routines…</p> : null}
          {routines !== null ? (
            <section className="space-y-2">
              <h3 className="text-body font-medium text-fg">Your routines</h3>
              {mine.length ? (
                <RoutineList items={mine} busy={busy} personFor={personFor} threads={threads} onOpen={(r) => setView({ mode: "edit", id: r.id, profile: r.profile })} onToggle={toggle} />
              ) : (
                <div className="rounded-card border border-dashed border-line-2 px-4 py-5 text-center">
                  <p className="text-callout text-fg-2">No routines yet.</p>
                  <p className="mt-1 text-caption text-fg-3">For example: every weekday at 07:30, {assistant} summarizes what&apos;s due today.</p>
                </div>
              )}
            </section>
          ) : null}
          {builtIn.length ? (
            <section className="space-y-2">
              <div>
                <h3 className="text-body font-medium text-fg">Built in</h3>
                <p className="text-caption text-fg-3">The app&apos;s own upkeep. Change when they run, or switch them off.</p>
              </div>
              <RoutineList items={builtIn} busy={busy} personFor={personFor} threads={threads} onOpen={(r) => setView({ mode: "edit", id: r.id, profile: r.profile })} onToggle={toggle} />
            </section>
          ) : null}
        </motion.div>
      ) : (
        <motion.div
          key={view.mode === "edit" ? `edit-${view.id}` : "new"}
          initial={{ x: 32, opacity: 0 }}
          animate={{ x: 0, opacity: 1, transition: { duration: 0.22, ease: EASE.enter } }}
          exit={{ x: 32, opacity: 0, transition: { duration: 0.12 } }}
          className="px-4 pb-10 pt-1"
        >
          <RoutineEditor
            key={view.mode === "edit" ? view.id : "new"}
            routine={editing}
            bots={bots}
            threads={threads}
            personFor={personFor}
            onBack={() => setView({ mode: "list" })}
            onDone={async (text) => {
              await load();
              setNote({ tone: "ok", text });
              setView({ mode: "list" });
            }}
            onChanged={load}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ the list */

function RoutineList({
  items,
  busy,
  personFor,
  threads,
  onOpen,
  onToggle,
}: {
  items: TeamRoutine[];
  busy: string;
  personFor: (profile: string) => Person | undefined;
  threads: ChatThread[];
  onOpen: (r: TeamRoutine) => void;
  onToggle: (r: TeamRoutine, on: boolean) => void;
}) {
  return (
    <ul className="divide-y divide-(--line-1) overflow-hidden rounded-card border border-line bg-card">
      {items.map((r) => {
        const person = personFor(r.profile);
        const result = lastResult(r);
        const next = r.enabled ? whenLabel(r.nextRun) : "";
        const label = routineLabel(r);
        return (
          <li key={`${r.profile}/${r.id}`} className={`flex items-center gap-3 pr-3 ${busy === r.id ? "opacity-60" : ""}`}>
            <button type="button" onClick={() => onOpen(r)} className="press flex min-w-0 flex-1 items-center gap-3 py-3 pl-3 text-left hover:bg-white/3">
              <span className="shrink-0" title={`Runs as ${r.bot}`}>
                {person ? <BotFace {...faceProps(person)} size={30} still /> : <span aria-hidden className="grid size-[30px] place-items-center rounded-full bg-well text-caption text-fg-3">{r.bot.slice(0, 1)}</span>}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-body ${r.enabled ? "text-fg" : "text-fg-3"}`}>{label.name}</span>
                <span className="line-clamp-2 text-caption text-fg-3">
                  {label.group ? `${label.group} · ` : ""}
                  {r.schedule.text}
                  {next ? ` · next ${next}` : r.enabled ? "" : " · off"}
                  {r.thread && r.thread !== "main" ? ` · ${threads.find((t) => t.id === r.thread)?.title || "a thread"}` : ""}
                </span>
                {result?.bad ? (
                  <span className="mt-0.5 flex items-center gap-1 text-caption text-danger">
                    <CircleAlertIcon className="size-3.5" />
                    {result.text} {whenLabel(r.lastRun).toLowerCase()}
                  </span>
                ) : null}
              </span>
              <ChevronRightIcon size={16} className="shrink-0 text-fg-3" />
            </button>
            <Switch label={`${r.name} ${r.enabled ? "on" : "off"}`} checked={r.enabled} disabled={!!busy} onChange={(on) => onToggle(r, on)} />
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ the editor */

const KINDS: [ScheduleKind, string][] = [
  ["daily", "Daily"],
  ["weekdays", "Weekdays"],
  ["weekly", "Weekly"],
  ["hourly", "Hourly"],
  ["custom", "Custom"],
];

function initialSchedule(s?: RoutineSchedule): RoutineSchedule {
  if (!s) return { kind: "weekdays", time: "07:30", days: [1], every: 3 };
  return { time: "08:00", days: [1], every: 3, ...s };
}

/** The draft schedule in plain words, before saving. */
export function scheduleText(s: RoutineSchedule): string {
  const at = s.time || "--:--";
  if (s.kind === "daily") return `Every day at ${at}`;
  if (s.kind === "weekdays") return `Weekdays at ${at}`;
  if (s.kind === "weekly") return s.days?.length ? `${[...s.days].sort().map((d) => DAY_NAMES[d]).join(", ")} at ${at}` : "Pick at least one day";
  if (s.kind === "hourly") return s.every === 1 ? "Every hour" : `Every ${s.every || "?"} hours`;
  return s.cron ? `Custom: ${s.cron}` : "Write a schedule";
}

function sameSchedule(a: RoutineSchedule, b: RoutineSchedule): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "hourly") return a.every === b.every;
  if (a.kind === "custom") return (a.cron || "").trim() === (b.cron || "").trim();
  if (a.kind === "weekly") return a.time === b.time && [...(a.days || [])].sort().join() === [...(b.days || [])].sort().join();
  return a.time === b.time;
}

function scheduleBody(s: RoutineSchedule): RoutineSchedule {
  if (s.kind === "hourly") return { kind: "hourly", every: s.every };
  if (s.kind === "custom") return { kind: "custom", cron: s.cron };
  if (s.kind === "weekly") return { kind: "weekly", time: s.time, days: s.days };
  return { kind: s.kind, time: s.time };
}

function RoutineEditor({
  routine,
  bots,
  threads,
  personFor,
  onBack,
  onDone,
  onChanged,
}: {
  routine?: TeamRoutine;
  bots: RoutineBot[];
  threads: ChatThread[];
  personFor: (profile: string) => Person | undefined;
  onBack: () => void;
  onDone: (text: string) => Promise<void>;
  onChanged: () => Promise<void>;
}) {
  const ids = useId();
  const creating = !routine;
  const locked = !!routine && (routine.builtIn || routine.kind === "script");
  const [name, setName] = useState(routine?.name || "");
  const [prompt, setPrompt] = useState(routine?.prompt || "");
  const [schedule, setSchedule] = useState<RoutineSchedule>(() => initialSchedule(routine?.schedule));
  const [profile, setProfile] = useState(routine?.profile || "chief");
  const [thread, setThread] = useState(routine?.thread ?? "main");
  const [saving, setSaving] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [note, setNote] = useState<Note | null>(null);

  const changes: Record<string, unknown> = {};
  if (routine) {
    if (!locked && name.trim() !== routine.name) changes.name = name.trim();
    if (!locked && prompt.trim() !== routine.prompt.trim()) changes.prompt = prompt.trim();
    if (!sameSchedule(schedule, routine.schedule)) changes.schedule = scheduleBody(schedule);
    if (routine.kind !== "script" && thread !== (routine.thread ?? "main")) changes.thread = thread;
  }
  const dirty = creating ? !!(name.trim() && prompt.trim()) : Object.keys(changes).length > 0;

  async function run(label: string, fn: () => Promise<{ ok: boolean; error?: string }>, after: (() => Promise<void>) | null) {
    setSaving(label);
    setNote(null);
    try {
      const res = await fn();
      if (!res.ok) throw new Error(res.error || "That didn't work.");
      if (after) await after();
    } catch (e) {
      setNote({ tone: "error", text: e instanceof Error ? e.message : "That didn't work." });
    } finally {
      setSaving("");
    }
  }

  const save = () =>
    run(
      "save",
      () =>
        creating
          ? routinesApi.create({ profile, name: name.trim(), prompt: prompt.trim(), schedule: scheduleBody(schedule), thread })
          : routinesApi.update(routine.profile, routine.id, changes),
      () => onDone(creating ? `${name.trim()} is scheduled.` : "Saved."),
    );

  const result = routine ? lastResult(routine) : null;
  const shownName = routine ? routineLabel(routine).name : "New routine";
  const runner = personFor(profile);
  const threadOptions = [{ id: "main", title: "Main chat" }, ...threads.filter((t) => t.id !== "main").map((t) => ({ id: t.id, title: t.title }))];

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} aria-label="Back to routines" className="press -ml-2 grid size-10 place-items-center rounded-full text-fg-2 hover:bg-white/6 hover:text-fg">
          <ChevronLeftIcon size={18} />
        </button>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-headline font-semibold text-fg">{shownName}</h3>
          {routine ? <p className="text-caption text-fg-3">{routine.builtIn ? `Built in · ${routineLabel(routine).group}` : routine.kind === "script" ? "A script routine" : `Runs as ${routine.bot}`}</p> : null}
        </div>
      </div>

      {routine ? (
        <dl className="grid grid-cols-2 gap-2">
          <Stat label="Next run" value={routine.enabled ? whenLabel(routine.nextRun) || "Not scheduled" : "Switched off"} />
          <Stat
            label="Last run"
            value={routine.lastRun ? `${whenLabel(routine.lastRun)}` : "Not yet"}
            extra={result ? <span className={`text-caption ${result.bad ? "text-danger" : "text-ok"}`}>{result.text}</span> : null}
          />
        </dl>
      ) : null}
      {routine?.lastError && result?.bad ? (
        <p role="alert" className="rounded-card border border-danger/30 bg-danger/6 px-3 py-2 text-caption text-fg-2">
          {routine.lastError.replace(/^\[[a-z_]+\]\s*/, "")}
        </p>
      ) : null}
      {routine?.lastOutput ? (
        <details className="group rounded-card border border-line bg-card">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-callout text-fg-2 hover:text-fg">
            <ChevronRightIcon size={14} className="transition-transform group-open:rotate-90" />
            Latest report
          </summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap wrap-break-word border-t border-line px-3 py-2 font-sans text-callout text-fg-2">{routine.lastOutput}</pre>
        </details>
      ) : null}

      <Labeled id={`${ids}-name`} label="Name">
        <input
          id={`${ids}-name`}
          value={locked ? shownName : name}
          disabled={locked}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="Morning brief"
          className="min-h-11 w-full rounded-ctl border border-line-2 bg-canvas px-3 text-body text-fg outline-hidden placeholder:text-fg-3 focus:border-line-3 disabled:opacity-70"
        />
      </Labeled>

      <Labeled id={`${ids}-what`} label="What it should do" hint={locked ? "The app's own wording, kept as it is." : "Write it as you would ask in the chat. Its answer is posted where it reports."}>
        <textarea
          id={`${ids}-what`}
          rows={5}
          value={prompt}
          disabled={locked}
          maxLength={4000}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Summarize what's due today from my tasks and calendar, and flag anything overdue."
          className="w-full resize-y rounded-ctl border border-line-2 bg-canvas px-3 py-2 text-body text-fg outline-hidden placeholder:text-fg-3 focus:border-line-3 disabled:opacity-70"
        />
      </Labeled>

      <fieldset className="space-y-2.5">
        <legend className="mb-1.5 px-1 text-caption font-medium uppercase tracking-wider text-fg-3">When</legend>
        <Segmented label="How often" value={schedule.kind} options={KINDS} onChange={(kind) => setSchedule((s) => ({ ...s, kind }))} />
        {schedule.kind === "weekly" ? (
          <div role="group" aria-label="Days" className="flex justify-between gap-1">
            {DAY_NAMES.map((d, i) => {
              const on = schedule.days?.includes(i) ?? false;
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setSchedule((s) => ({ ...s, days: on ? (s.days || []).filter((x) => x !== i) : [...(s.days || []), i] }))}
                  className={`press grid size-10 place-items-center rounded-full text-caption font-medium transition-colors ${on ? "bg-accent-solid text-white" : "bg-well text-fg-3 hover:text-fg-2"}`}
                >
                  {d.slice(0, 2)}
                </button>
              );
            })}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          {schedule.kind === "daily" || schedule.kind === "weekdays" || schedule.kind === "weekly" ? (
            <>
              <label htmlFor={`${ids}-time`} className="text-callout text-fg-2">
                At
              </label>
              <input
                id={`${ids}-time`}
                type="time"
                value={schedule.time || ""}
                onChange={(e) => setSchedule((s) => ({ ...s, time: e.target.value }))}
                className="min-h-11 w-34 rounded-ctl border border-line-2 bg-canvas px-2 text-body text-fg outline-hidden focus:border-line-3"
              />
            </>
          ) : null}
          {schedule.kind === "hourly" ? (
            <>
              <label htmlFor={`${ids}-every`} className="text-callout text-fg-2">
                Every
              </label>
              <input
                id={`${ids}-every`}
                type="number"
                min={1}
                max={24}
                value={schedule.every ?? ""}
                onChange={(e) => setSchedule((s) => ({ ...s, every: Math.max(1, Math.min(24, Number(e.target.value) || 1)) }))}
                className="min-h-11 w-20 rounded-ctl border border-line-2 bg-canvas px-2 text-body tabular text-fg outline-hidden focus:border-line-3"
              />
              <span className="text-callout text-fg-2">{schedule.every === 1 ? "hour" : "hours"}</span>
            </>
          ) : null}
          {schedule.kind === "custom" ? (
            <div className="w-full">
              <label htmlFor={`${ids}-cron`} className="sr-only">
                Custom schedule
              </label>
              <input
                id={`${ids}-cron`}
                value={schedule.cron || ""}
                onChange={(e) => setSchedule((s) => ({ ...s, cron: e.target.value }))}
                placeholder="30 7 * * 1-5"
                spellCheck={false}
                className="min-h-11 w-full rounded-ctl border border-line-2 bg-canvas px-3 font-mono text-code text-fg outline-hidden placeholder:text-fg-3 focus:border-line-3"
              />
              <p className="mt-1 px-1 text-caption text-fg-3">A cron line (minute hour day month weekday), or an interval like &quot;every 2h&quot;.</p>
            </div>
          ) : null}
        </div>
        <p className="px-1 text-caption text-fg-3" aria-live="polite">
          {scheduleText(schedule)} · this computer&apos;s time
        </p>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1.5 px-1 text-caption font-medium uppercase tracking-wider text-fg-3">Runs as</legend>
        {creating ? (
          <div role="radiogroup" aria-label="Who runs it" className="flex flex-wrap gap-2">
            {bots.map((b) => {
              const p = personFor(b.id);
              const on = b.id === profile;
              return (
                <button
                  key={b.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setProfile(b.id)}
                  className={`press flex min-h-11 items-center gap-2 rounded-full border py-1 pl-1.5 pr-3.5 text-callout transition-colors ${
                    on ? "border-accent/70 bg-accent/12 text-fg" : "border-line-2 text-fg-2 hover:text-fg"
                  }`}
                >
                  {p ? <BotFace {...faceProps(p)} size={26} still /> : <span aria-hidden className="grid size-[26px] place-items-center rounded-full bg-well text-caption">{b.name.slice(0, 1)}</span>}
                  {b.name}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex items-center gap-2.5 px-1">
            {runner ? <BotFace {...faceProps(runner)} size={26} still /> : null}
            <span className="text-body text-fg">{routine.bot}</span>
            <span className="text-caption text-fg-3">· to change who runs it, make a new routine</span>
          </div>
        )}
        {creating ? <p className="px-1 text-caption text-fg-3">It runs with that bot&apos;s identity, model and skills.</p> : null}
      </fieldset>

      {routine?.kind === "script" ? null : (
        <Labeled id={`${ids}-thread`} label="Reports to" hint={routine?.silent ? "It reports nowhere at the moment; pick a thread to see its results in the chat." : "Its answer arrives in this chat thread."}>
          <select
            id={`${ids}-thread`}
            value={thread}
            onChange={(e) => setThread(e.target.value)}
            className="min-h-11 w-full rounded-ctl border border-line-2 bg-canvas px-3 text-body text-fg outline-hidden focus:border-line-3"
          >
            {routine?.silent ? <option value="">Nowhere</option> : null}
            {threadOptions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        </Labeled>
      )}

      {note ? <NoteLine note={note} /> : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <button
          type="button"
          disabled={!dirty || !!saving}
          onClick={() => void save()}
          className="press min-h-11 rounded-full bg-fg px-5 text-callout font-semibold text-canvas disabled:opacity-50"
        >
          {saving === "save" ? "Saving…" : creating ? "Create routine" : "Save changes"}
        </button>
        {routine ? (
          <button
            type="button"
            disabled={!!saving}
            onClick={() =>
              void run(
                "run",
                () => routinesApi.run(routine.profile, routine.id),
                async () => {
                  setNote({ tone: "ok", text: "Started. Its report arrives in the chat when it's done." });
                  await onChanged();
                },
              )
            }
            className="press min-h-11 rounded-full border border-line-2 px-4 text-callout font-medium text-fg-2 hover:text-fg disabled:opacity-50"
          >
            {saving === "run" ? "Starting…" : "Run now"}
          </button>
        ) : null}
        {routine && !routine.builtIn ? (
          <button
            type="button"
            disabled={!!saving}
            onClick={() => setConfirmDelete((v) => !v)}
            className="press ml-auto min-h-11 rounded-full px-3 text-callout font-medium text-danger hover:bg-danger/8 disabled:opacity-50"
          >
            Delete…
          </button>
        ) : null}
      </div>
      {routine && confirmDelete ? (
        <div className="space-y-2 rounded-card border border-danger/30 bg-danger/6 px-3 py-3">
          <p className="text-callout text-fg">Delete {routine.name}? It stops running; earlier reports stay in the chat.</p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!!saving}
              onClick={() => void run("delete", () => routinesApi.remove(routine.profile, routine.id), () => onDone(`${routine.name} was deleted.`))}
              className="press min-h-10 rounded-full bg-danger px-4 text-callout font-medium text-white disabled:opacity-50"
            >
              {saving === "delete" ? "Deleting…" : "Delete routine"}
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} className="press min-h-10 rounded-full border border-line-2 px-4 text-callout text-fg-2 hover:text-fg">
              Keep it
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Labeled({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block px-1 text-caption font-medium uppercase tracking-wider text-fg-3">
        {label}
      </label>
      {children}
      {hint ? <p className="mt-1 px-1 text-caption text-fg-3">{hint}</p> : null}
    </div>
  );
}

function Stat({ label, value, extra }: { label: string; value: string; extra?: ReactNode }) {
  return (
    <div className="rounded-card border border-line bg-card px-3 py-2">
      <dt className="text-caption text-fg-3">{label}</dt>
      <dd className="text-callout text-fg">{value}</dd>
      {extra ? <dd>{extra}</dd> : null}
    </div>
  );
}

function NoteLine({ note }: { note: Note }) {
  const Icon = note.tone === "ok" ? CircleCheckIcon : CircleAlertIcon;
  return (
    <p role={note.tone === "error" ? "alert" : "status"} className={`flex items-start gap-2 text-callout ${note.tone === "error" ? "text-danger" : "text-fg-2"}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${note.tone === "ok" ? "text-ok" : ""}`} />
      <span>{note.text}</span>
    </p>
  );
}
