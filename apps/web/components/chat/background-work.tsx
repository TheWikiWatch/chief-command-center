"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { ChevronDownIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { field } from "@/components/ui/field";
import { helperTail, steerHelper, stopHelper } from "@/lib/bridge";
import { friendlyError } from "@/lib/request";
import { DUR, EASE } from "@/lib/motion";
import type { BackgroundTask, BackgroundUnit } from "@/lib/types";

const OPEN_KEY = "chief.backgroundWork.open";

/** "3:07", "1:02:45": how long the oldest background task has been running. */
export function elapsedLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function backgroundTaskCount(units: BackgroundUnit[]): number {
  return units.reduce((n, u) => n + u.tasks.length, 0);
}

/**
 * Work the chief handed to helpers that is still running after its turn ended (Hermes runs delegated tasks in the
 * background; their results come back later as a message). Without this the chief looked idle while four research
 * lanes ran. A one-line summary that opens to each task's goal and current step; gone when the work is done.
 * A live helper (Hermes 0.22) opens further: its log as it works, a note to it ("Focus on lane B"), or Stop; what
 * a stopped helper found so far still comes back as a message.
 */
export function BackgroundWork({ units, assistant, color }: { units: BackgroundUnit[]; assistant: string; color?: string }) {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [now, setNow] = useState(() => Date.now() / 1000);
  const count = backgroundTaskCount(units);
  useEffect(() => {
    if (!count) return undefined;
    const tick = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(tick);
  }, [count]);
  if (!count) return null;
  const since = Math.min(...units.map((u) => u.since || now));
  const toggle = () =>
    setOpen((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? "0" : "1");
      } catch {
        // a private window: the choice just isn't remembered
      }
      return !v;
    });

  return (
    <section aria-label="Background work" className="mb-2 overflow-hidden rounded-card border border-line bg-card/70">
      <button type="button" aria-expanded={open} onClick={toggle} className="press flex min-h-11 w-full items-center gap-2.5 px-3 text-left">
        {/* The chief's own colour: busy, not an alert (the theme's accent is red). */}
        <span aria-hidden className="relative flex size-2 shrink-0" style={{ color: color || "rgb(var(--c-fg-2))" }}>
          <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-50" />
          <span className="relative size-2 rounded-full bg-current" />
        </span>
        <span className="min-w-0 flex-1 truncate text-callout">
          <span className="font-medium text-fg">
            {count} task{count === 1 ? "" : "s"} in the background
          </span>
          <span className="sr-only"> ({assistant} is still working on them)</span>
        </span>
        <span className="shrink-0 font-mono text-caption tabular-nums text-fg-3" aria-label={`running for ${elapsedLabel(now - since)}`}>
          {elapsedLabel(now - since)}
        </span>
        <ChevronDownIcon className={`size-4 shrink-0 text-fg-3 transition-transform duration-fast ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul
            key="tasks"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: { duration: DUR.base, ease: EASE.enter } }}
            exit={{ height: 0, opacity: 0, transition: { duration: DUR.fast, ease: EASE.exit } }}
            className="max-h-[40vh] overflow-y-auto overscroll-contain border-t border-line"
          >
            {units.flatMap((u) =>
              u.tasks.map((t, i) => <HelperRow key={`${u.id}-${t.id || i}`} task={t} stalling={u.status === "stalling"} />),
            )}
            <li className="px-3 pb-2.5 pt-1 text-caption text-fg-3">The results come back here as a message when they're done.</li>
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </section>
  );
}

const TAIL_MS = 2000;

/** One task; a live helper opens to its log, a note box and Stop. */
function HelperRow({ task, stalling }: { task: BackgroundTask; stalling: boolean }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState("");
  const [read, setRead] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [said, setSaid] = useState("");
  const [error, setError] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const id = task.id || "";

  useEffect(() => {
    if (!open || !id) return undefined;
    const ctrl = new AbortController();
    const read = () =>
      helperTail(id, ctrl.signal)
        .then((r) => {
          if (!r.ok) return setError(r.error || "");
          setLog(r.text || "");
          setRead(true);
          setError("");
        })
        .catch(() => undefined);
    void read();
    const timer = setInterval(read, TAIL_MS);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
  }, [open, id]);

  // Follow the end of the log, like tail -f.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  async function act(kind: "steer" | "stop") {
    setBusy(kind);
    setError("");
    setSaid("");
    try {
      const res = kind === "steer" ? await steerHelper(id, note.trim()) : await stopHelper(id);
      if (!res.ok) throw new Error(res.error || "That didn't reach the helper.");
      if (kind === "steer") {
        setNote("");
        setSaid("Sent. It reads it after its current step.");
      } else {
        setConfirmStop(false);
        setSaid("Stopping after its current step. What it found so far comes back as a message.");
      }
    } catch (e) {
      setError(friendlyError(e, "That didn't reach the helper."));
    } finally {
      setBusy("");
    }
  }

  const head = (
    <>
      <span aria-hidden className={`mt-1.5 size-1.5 shrink-0 rounded-full ${stalling ? "bg-warn" : "bg-fg-3"}`} />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-callout text-fg-2">{task.goal || "A task"}</span>
        <span className={`mt-0.5 block text-caption ${stalling ? "text-warn" : "shimmer-text"}`}>
          {task.step}
          {task.toolCount ? ` · ${task.toolCount} step${task.toolCount === 1 ? "" : "s"} so far` : ""}
        </span>
      </span>
    </>
  );

  if (!id) return <li className="flex gap-2.5 px-3 py-2.5 [&+&]:border-t [&+&]:border-line/60">{head}</li>;
  return (
    <li className="[&+&]:border-t [&+&]:border-line/60">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="press flex w-full gap-2.5 px-3 py-2.5 text-left hover:bg-fill-1">
        {head}
        <ChevronDownIcon className={`mt-0.5 size-4 shrink-0 text-fg-3 transition-transform duration-fast ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="space-y-2 px-3 pb-3">
          <pre ref={logRef} aria-label="What the helper is doing" className="max-h-48 overflow-y-auto whitespace-pre-wrap wrap-break-word rounded-ctl bg-well px-2.5 py-2 font-mono text-micro text-fg-3">
            {log || (read ? "Nothing in its log yet." : "Reading its log…")}
          </pre>
          {task.steer ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (note.trim()) void act("steer");
              }}
            >
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                placeholder="Tell it something, like: focus on prices"
                aria-label="A note for this helper"
                className={field({ extra: "min-w-0 flex-1" })}
              />
              <Button type="submit" variant="secondary" size="sm" disabled={!note.trim() || !!busy}>
                {busy === "steer" ? "Sending…" : "Send"}
              </Button>
            </form>
          ) : null}
          {confirmStop ? (
            <div className="flex flex-wrap items-center gap-2 rounded-ctl bg-fill-1 px-3 py-2">
              <p className="min-w-0 flex-1 text-callout text-fg-2">Stop this helper? What it found so far still comes back.</p>
              <Button variant="danger" size="sm" disabled={!!busy} onClick={() => void act("stop")}>
                {busy === "stop" ? "Stopping…" : "Stop it"}
              </Button>
              <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => setConfirmStop(false)}>
                Keep going
              </Button>
            </div>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setConfirmStop(true)}>
              Stop this helper
            </Button>
          )}
          {said ? (
            <p role="status" className="text-caption text-fg-2">
              {said}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-caption text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
