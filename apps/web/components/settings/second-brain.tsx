"use client";

import { useEffect, useState } from "react";
import { BookOpenIcon, ChevronRightIcon } from "@/components/icons";
import { Group, Row } from "@/components/ui/settings-group";
import { Switch } from "@/components/ui/controls";
import { useAssistantName } from "@/lib/identity";
import { openTeam } from "@/lib/settings-nav";
import { FORMAT_INFO, SecondBrainSetup } from "@/components/second-brain/setup";
import { secondBrain, type Routine, type SecondBrainStatus } from "@/lib/setup-client";
import { useAppConfig } from "@/lib/app-config";
import { field } from "@/components/ui/field";
import { MODE_LABEL } from "@/components/settings-panel";

/* Settings → Second Brain: the folder and its routines. */

export function SecondBrainGroup({ onAskChief }: { onAskChief?: (text: string) => Promise<void> }) {
  const config = useAppConfig();
  const [status, setStatus] = useState<SecondBrainStatus | null>(null);
  const [error, setError] = useState("");
  const [changing, setChanging] = useState(false);
  const load = () => {
    setError("");
    secondBrain
      .status()
      .then(setStatus)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't read the Second Brain."));
  };
  useEffect(load, []);
  const fromEnv = config.secondBrain.source === "env";
  const path = fromEnv ? config.vaultRoot : status?.path || "";
  return (
    <Group
      icon={<BookOpenIcon className="size-4" />}
      title="Second Brain"
      hint="Your notes folder. Today reads its tasks; Vault browses it."
      action={
        fromEnv ? null : (
          <button
            type="button"
            onClick={() => {
              setChanging((v) => !v);
              if (changing) load();
            }}
            className="press min-h-9 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg"
          >
            {changing ? "Close" : status?.configured ? "Change" : "Set up"}
          </button>
        )
      }
    >
      {changing ? (
        <div className="px-1 py-2">
          <SecondBrainSetup onAskChief={onAskChief} onDone={load} />
        </div>
      ) : (
        <>
          <Row
            label={path ? <span className="break-all font-mono text-code">{path}</span> : status ? "Not set up" : "…"}
            hint={
              error ||
              (fromEnv
                ? "Set by this install's configuration (CHIEF_VAULT_PATH)."
                : status?.configured
                  ? `${status.exists ? (status.format ? `${FORMAT_INFO[status.format].label}${status.rules ? ` · follows ${status.rules}` : ""}` : MODE_LABEL[status.mode || ""] || "Connected") : "The folder is missing"}${config.secondBrain.today === "ops" ? " · Today uses your task service" : ""}`
                  : "Choose a folder to keep notes and tasks with your chief.")
            }
          />
          {status?.configured && !fromEnv ? <RoutineRows /> : null}
        </>
      )}
    </Group>
  );
}

/** One routine: its time (saved when the field is left) and an on/off switch. */
export function RoutineRow({ routine: r, busy, onChange }: { routine: Routine; busy: string; onChange: (next: { enabled?: boolean; time?: string }) => void }) {
  const [time, setTime] = useState(r.time);
  useEffect(() => setTime(r.time), [r.time]);
  const commit = () => {
    if (time && time !== r.time) onChange({ time });
  };
  return (
    <li className={`py-3 ${busy === r.id ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-callout text-fg">{r.title}</p>
          <p className="mt-0.5 text-caption text-fg-3">{r.about}</p>
        </div>
        <Switch label={`${r.title} ${r.enabled ? "on" : "off"}`} checked={r.enabled} disabled={!!busy} onChange={(on) => onChange({ enabled: on })} />
      </div>
      <div className={`mt-2 flex items-center gap-2 ${r.enabled ? "" : "opacity-50"}`}>
        {r.time ? (
          <>
            <label className="sr-only" htmlFor={`routine-${r.id}`}>
              {r.title} time
            </label>
            <input
              id={`routine-${r.id}`}
              type="time"
              value={time}
              disabled={!!busy}
              onChange={(e) => setTime(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              className={field({ extra: "min-h-9 w-32 px-2 text-callout disabled:opacity-60" })}
            />
          </>
        ) : null}
        <span className="text-caption text-fg-3">{r.days}</span>
      </div>
    </li>
  );
}

/** The Second Brain's scheduled routines: each on or off, at the time the owner picks. */
export function RoutineRows() {
  const assistant = useAssistantName();
  const [items, setItems] = useState<Routine[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    secondBrain
      .routines()
      .then((r) => (r.ok ? setItems(r.routines) : setError(r.error || "Couldn't read the routines.")))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't read the routines."));
  }, []);
  async function change(id: string, next: { enabled?: boolean; time?: string }) {
    setBusy(id);
    setError("");
    try {
      const res = await secondBrain.setRoutine(id, next);
      if (!res.ok) throw new Error(res.error || "That didn't save.");
      setItems(res.routines);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save.");
    } finally {
      setBusy("");
    }
  }
  if (!items && !error) return <Row label="Routines" hint="Reading…" />;
  return (
    <div className="px-3.5 py-3">
      <p className="text-body text-fg">Routines</p>
      <p className="mt-0.5 text-caption text-fg-3">{assistant} looks after the Second Brain on a schedule and tells you what changed.</p>
      {error ? (
        <p role="alert" className="mt-2 text-caption text-danger">
          {error}
        </p>
      ) : null}
      <ul className="mt-2 divide-y divide-(--line-1)">
        {(items || []).map((r) => (
          <RoutineRow key={r.id} routine={r} busy={busy} onChange={(next) => void change(r.id, next)} />
        ))}
      </ul>
      <button type="button" onClick={() => openTeam("routines")} className="press mt-1 flex min-h-10 items-center gap-1 text-callout font-medium text-accent-text hover:underline">
        All routines, for every bot
        <ChevronRightIcon size={14} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ Identity and memory */
