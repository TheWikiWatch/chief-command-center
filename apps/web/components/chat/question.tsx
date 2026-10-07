"use client";

import { motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import { BotFace, faceProps } from "@/components/bot-face";
import { BellIcon, CheckIcon, CircleAlertIcon, ClockIcon } from "@/components/icons";
import { useAssistantName } from "@/lib/identity";
import { EASE } from "@/lib/motion";
import type { AskedQuestion, ChatNotice, PendingQuestion, Person } from "@/lib/types";
import { linkifyVaultRefs } from "@/lib/vault-client";
import { field as fieldClass } from "@/components/ui/field";
import { btn } from "@/components/ui/button";
import { openTeam } from "@/lib/settings-nav";
import { routinesApi } from "@/lib/routines-client";

/** Hermes appends this to the choice it recommends; the card shows it as a badge instead. */
const RECOMMENDED = /\s*\(recommended\)\s*$/i;

export function choiceLabel(choice: string) {
  return { text: choice.replace(RECOMMENDED, ""), recommended: RECOMMENDED.test(choice) };
}

/**
 * The chief's open question. The turn waits until it's answered: tap a choice (or several, then Send),
 * or "Something else" to answer in your own words. Typing in the message box answers it too.
 */
export function QuestionCard({
  question,
  chief,
  onAnswer,
}: {
  question: PendingQuestion;
  chief: Person | undefined;
  onAnswer: (id: string, answer: string | string[]) => Promise<void>;
}) {
  const assistant = useAssistantName();
  const headingId = useId();
  const [picked, setPicked] = useState<string[]>([]);
  const [own, setOwn] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setPicked([]);
    setOwn(false);
    setText("");
    setError("");
  }, [question.id]);
  useEffect(() => {
    if (own) field.current?.focus();
  }, [own]);

  async function send(answer: string | string[], key: string) {
    setBusy(key);
    setError("");
    try {
      await onAnswer(question.id, answer);
    } catch (e) {
      setError(e instanceof Error ? e.message : `Couldn't send your answer to ${assistant}.`);
      setBusy("");
    }
  }

  const choices = question.choices;
  return (
    <motion.section
      aria-labelledby={headingId}
      className="mt-5 flex gap-2.5"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE.enter } }}
      exit={{ opacity: 0, transition: { duration: 0.14 } }}
    >
      <div className="w-7 shrink-0 pt-0.5">{chief ? <BotFace {...faceProps(chief)} mood="waiting" size={28} /> : null}</div>
      <div className="min-w-0 flex-1 rounded-card border border-accent/30 bg-accent/6 px-3.5 py-3">
        <p className="text-caption font-medium text-accent-text">{assistant} is asking</p>
        <h3 id={headingId} className="mt-1 text-body font-medium text-fg">
          {question.question}
        </h3>
        {choices.length ? (
          <div className="mt-3 flex flex-col gap-2" role={question.multi ? "group" : undefined} aria-label={question.multi ? "Choose any that apply" : undefined}>
            {choices.map((choice) => {
              const { text: label, recommended } = choiceLabel(choice);
              const on = picked.includes(choice);
              return (
                <button
                  key={choice}
                  type="button"
                  disabled={!!busy}
                  aria-pressed={question.multi ? on : undefined}
                  onClick={() =>
                    question.multi ? setPicked((p) => (on ? p.filter((c) => c !== choice) : [...p, choice])) : void send(choice, choice)
                  }
                  className={`press flex min-h-11 w-full items-center gap-2.5 rounded-ctl border px-3 py-2 text-left text-body transition-colors disabled:opacity-60 ${
                    on ? "border-accent bg-accent/15 text-fg" : "border-line-2 bg-canvas/60 text-fg hover:border-line-3"
                  }`}
                >
                  {question.multi ? (
                    <span className={`grid size-5 shrink-0 place-items-center rounded-chip border ${on ? "border-accent bg-accent text-canvas" : "border-line-3"}`}>
                      {on ? <CheckIcon size={14} /> : null}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1">{busy === choice ? "Sending…" : label}</span>
                  {recommended ? <span className="shrink-0 rounded-full bg-ok/15 px-2 py-0.5 text-caption text-ok">Recommended</span> : null}
                </button>
              );
            })}
          </div>
        ) : null}
        {own || !choices.length ? (
          <form
            className="mt-3 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) void send(text.trim(), "own");
            }}
          >
            <label htmlFor={`${headingId}-own`} className="sr-only">
              Your answer
            </label>
            <textarea
              id={`${headingId}-own`}
              ref={field}
              rows={2}
              value={text}
              disabled={!!busy}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Your answer"
              className={fieldClass({ extra: "w-full resize-none py-2" })}
            />
            <button type="submit" disabled={!text.trim() || !!busy} className={btn("primary", "md")}>
              {busy === "own" ? "Sending…" : "Send answer"}
            </button>
          </form>
        ) : null}
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {question.multi && choices.length ? (
            <button
              type="button"
              disabled={!picked.length || !!busy}
              onClick={() => void send(picked, "multi")}
              className={btn("primary", "md")}
            >
              {busy === "multi" ? "Sending…" : picked.length ? `Send ${picked.length} choice${picked.length === 1 ? "" : "s"}` : "Pick at least one"}
            </button>
          ) : null}
          {choices.length && !own ? (
            <button type="button" disabled={!!busy} onClick={() => setOwn(true)} className="press min-h-10 rounded-full border border-line-2 px-4 text-callout text-fg-2 hover:text-fg">
              Something else…
            </button>
          ) : null}
          <span className="text-caption text-fg-3">{assistant} is waiting for your answer.</span>
        </div>
        {error ? (
          <p role="alert" className="mt-2 flex items-start gap-2 text-callout text-danger">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}
      </div>
    </motion.section>
  );
}

/** A question the chief asked earlier, with the answer it got. */
export function AskedRow({ items }: { items: AskedQuestion[] }) {
  const assistant = useAssistantName();
  return (
    <div className="space-y-2">
      {items.map((item, i) => {
        const answers = Array.isArray(item.answer) ? item.answer : item.answer ? [item.answer] : [];
        return (
          <div key={i} className="rounded-card border border-line bg-card/60 px-3.5 py-2.5">
            <p className="text-caption text-fg-3">{assistant} asked</p>
            <p className="mt-0.5 text-body text-fg-2">{item.question}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {answers.length ? (
                answers.map((a) => (
                  <span key={a} className="inline-flex items-center gap-1 rounded-full bg-well px-2.5 py-1 text-callout text-fg">
                    <CheckIcon size={13} className="text-ok" />
                    {choiceLabel(a).text}
                  </span>
                ))
              ) : (
                <span className="text-callout text-fg-3">No answer</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const QUICK_LABELS: Record<string, string> = {
  "/approve": "Approve once",
  "/always": "Always approve",
  "/cancel": "Cancel",
  "/deny": "Deny",
  "/yes": "Yes",
  "/no": "No",
};

/** The commands a gateway prompt offers as its text fallback ("reply `/approve`, `/always`, or `/cancel`"). */
export function quickReplies(text: string): string[] {
  const line = text.split("\n").find((l) => /\breply\b/i.test(l) && /`\/[a-z][\w-]*`/i.test(l));
  if (!line) return [];
  return [...new Set([...line.matchAll(/`(\/[a-z][\w-]*)`/gi)].map((m) => m[1].toLowerCase()))].slice(0, 4);
}

/**
 * A scheduled job that failed (the bridge turns Hermes's announcement into `failure`): the routine, what went
 * wrong in one line, how many runs in a row, and the two things to do about it. Hermes's full text is a tap away.
 */
function RoutineFailure({ notice }: { notice: ChatNotice }) {
  const failure = notice.failure!;
  const routine = notice.routine;
  const [state, setState] = useState<"" | "running" | "ran" | "pausing" | "paused">("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const canAct = !!routine?.jobId && !!routine.profile;
  const acting = state === "running" || state === "pausing";
  async function act(kind: "run" | "pause") {
    if (!routine?.profile) return;
    setError("");
    setState(kind === "run" ? "running" : "pausing");
    try {
      const result =
        kind === "run" ? await routinesApi.run(routine.profile, routine.jobId) : await routinesApi.update(routine.profile, routine.jobId, { enabled: false });
      if (!result.ok) throw new Error(result.error || "That didn't work.");
      setState(kind === "run" ? "ran" : "paused");
    } catch (e) {
      setState("");
      setError(e instanceof Error ? e.message : "That didn't work.");
    }
  }
  return (
    <div className="rounded-card border border-danger/30 bg-danger/[0.07] px-3.5 py-2.5">
      <div className="flex items-center gap-1.5 text-caption font-medium text-fg-3">
        <ClockIcon size={13} />
        <span className="min-w-0 flex-1 truncate">{routine?.name || "Scheduled job"}</span>
        <button type="button" onClick={() => openTeam("routines")} className="press -my-1 shrink-0 rounded-full px-2 py-1 text-caption font-medium text-fg-3 hover:bg-fill-2 hover:text-fg">
          Manage
        </button>
      </div>
      <p className="mt-1 flex items-start gap-1.5 text-callout text-fg">
        <CircleAlertIcon size={15} className="mt-0.5 shrink-0 text-danger" />
        <span className="min-w-0 flex-1">Failed · {failure.error}</span>
        {failure.streak > 1 ? <span className="shrink-0 rounded-chip bg-danger/15 px-1.5 font-mono text-micro text-danger">{failure.streak} in a row</span> : null}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {canAct ? (
          <>
            <button type="button" disabled={acting || state === "ran"} onClick={() => void act("run")} className={btn("secondary", "sm")}>
              {state === "running" ? "Starting…" : state === "ran" ? "Started" : "Run again"}
            </button>
            <button type="button" disabled={acting || state === "paused"} onClick={() => void act("pause")} className={btn("ghost", "sm")}>
              {state === "pausing" ? "Pausing…" : state === "paused" ? "Paused" : "Pause"}
            </button>
          </>
        ) : null}
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="press rounded-full px-2 py-1 text-caption text-fg-3 hover:text-fg-2">
          {open ? "Hide details" : "Details"}
        </button>
      </div>
      {open ? <p className="mt-2 whitespace-pre-wrap font-mono text-micro text-fg-3">{failure.detail}</p> : null}
      {error ? (
        <p role="alert" className="mt-2 text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A scheduled job's result or a gateway notice: not a reply to anything you said. A notice that asks for
 * an answer (Hermes's text fallback, e.g. confirming /new) gets its answers as buttons while it is the newest
 * thing in the chat. */
export function NoticeBody({ notice, onQuickReply }: { notice: ChatNotice; onQuickReply?: (text: string) => Promise<void> }) {
  const [sent, setSent] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const replies = onQuickReply ? quickReplies(notice.text) : [];
  const scheduled = notice.source === "scheduled";
  if (notice.failure) return <RoutineFailure notice={notice} />;
  // A gateway notice (a restart, a reminder that it is busy) is a quiet line; it opens to the full text.
  if (!scheduled && !replies.length) {
    const times = notice.repeat && notice.until ? `${notice.repeat}× · until ${new Date(notice.until * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
    return (
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="press group flex w-full items-start gap-2 rounded-ctl px-2 py-1.5 text-left text-callout text-fg-3 hover:bg-fill-1 hover:text-fg-2"
      >
        <BellIcon size={14} className="mt-0.5 shrink-0" />
        <span className={`min-w-0 flex-1 ${open ? "whitespace-pre-wrap" : "truncate"}`}>{open ? notice.text.trim() : notice.text.replace(/\s+/g, " ").trim()}</span>
        {times ? <span className="shrink-0 rounded-chip bg-fill-2 px-1.5 font-mono text-micro text-fg-3">{times}</span> : null}
      </button>
    );
  }
  return (
    <div className="rounded-card border border-line bg-card/60 px-3.5 py-2.5">
      <div className="flex items-center gap-1.5 text-caption font-medium text-fg-3">
        {scheduled ? <ClockIcon size={13} /> : <BellIcon size={13} />}
        <span className="min-w-0 flex-1 truncate">{notice.routine?.name || (scheduled ? "Scheduled job" : "Notice")}</span>
        {notice.routine ? (
          <button type="button" onClick={() => openTeam("routines")} className="press -my-1 shrink-0 rounded-full px-2 py-1 text-caption font-medium text-fg-3 hover:bg-fill-2 hover:text-fg">
            Manage
          </button>
        ) : null}
      </div>
      <Streamdown className="chat-md mt-1 max-w-none">{linkifyVaultRefs(notice.text)}</Streamdown>
      {replies.length ? (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {replies.map((cmd) => (
            <button
              key={cmd}
              type="button"
              disabled={!!sent}
              onClick={async () => {
                setSent(cmd);
                setError("");
                try {
                  await onQuickReply!(cmd);
                } catch (e) {
                  setSent("");
                  setError(e instanceof Error ? e.message : "That didn't send.");
                }
              }}
              className={`press min-h-10 rounded-full px-4 text-callout font-medium disabled:opacity-60 ${
                cmd === "/cancel" || cmd === "/deny" || cmd === "/no" ? "border border-line-2 text-fg-2 hover:text-fg" : "bg-fg text-canvas"
              }`}
            >
              {sent === cmd ? "Sending…" : QUICK_LABELS[cmd] || cmd}
            </button>
          ))}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-callout text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
