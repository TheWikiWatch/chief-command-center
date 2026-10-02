"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { CircleCheckIcon } from "@/components/icons";
import { Sheet } from "@/components/ui/sheet";
import { SPRING } from "@/lib/motion";
import { ops, type Intent, type LaunchTarget } from "@/lib/ops";
import { useAssistantName } from "@/lib/identity";
import { LAYER } from "@/lib/layers";
import { FOCUS_INTENTS, TASK_INTENTS } from "@/components/today-pane";

/* The sheet for one task: discuss, update, block or reschedule it with the chief. */

export function IntentSheet({
  target,
  onClose,
  onSent,
  open = true,
}: {
  target: LaunchTarget;
  onClose: () => void;
  onSent: (text: string) => Promise<void>;
  open?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} bare scope="container" zIndex={LAYER.paneSheet} closeDisabled={busy}>
      <IntentBody target={target} onClose={onClose} onSent={onSent} onBusy={setBusy} />
    </Sheet>
  );
}

export function IntentBody({
  target,
  onClose,
  onSent,
  onBusy,
}: {
  target: LaunchTarget;
  onClose: () => void;
  onSent: (text: string) => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const assistant = useAssistantName();
  const isTask = target.kind === "task";
  const intents = isTask ? TASK_INTENTS : FOCUS_INTENTS;
  const [intent, setIntent] = useState<Intent>(intents[0].id);
  const [message, setMessage] = useState("");
  const [due, setDue] = useState("");
  const [blocker, setBlocker] = useState("");
  const [prepared, setPrepared] = useState<{ key: string; text: string } | null>(null);
  const [busy, setBusyState] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const setBusy = (v: boolean) => {
    setBusyState(v);
    onBusy(v);
  };

  useEffect(() => {
    setIntent(intents[0].id);
    setMessage("");
    setDue("");
    setBlocker("");
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.title, target.card?.id]);

  async function send(next: Intent) {
    setBusy(true);
    setErr(null);
    try {
      const key = JSON.stringify([next, target.board_name, target.card?.id, message, due, blocker]);
      const res = prepared?.key === key ? { kickoff: prepared.text } : await ops.launch({
        intent: next,
        board_name: target.board_name,
        card_id: target.card?.id ?? null,
        user_message: message,
        due: due || null,
        blocker: blocker || null,
        mode: "chat_inject",
      });
      const kickoff = res.kickoff?.trim();
      if (!kickoff) throw new Error("Launch did not return a kickoff.");
      setPrepared({ key, text: kickoff });
      await onSent(kickoff);
    } catch (e) {
      setErr(e instanceof Error ? e.message : `Could not send to ${assistant}.`);
    } finally {
      setBusy(false);
    }
  }

  const field = "mt-1.5 min-h-11 w-full rounded-ctl border border-line-2 bg-canvas px-3 py-2 text-body text-fg outline-hidden placeholder:text-fg-3 focus:border-line-3";
  return (
    <div className="px-4 pb-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="mb-1 flex items-center gap-1.5 text-caption text-fg-3">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: target.color }} />
            {target.kicker}
          </p>
          <h3 className="text-title text-fg">{target.title}</h3>
        </div>
        <button
          type="button"
          className="press -mr-1 min-h-11 rounded-full px-3 text-callout text-fg-2 hover:bg-fill-2 hover:text-fg disabled:opacity-40"
          disabled={busy}
          onClick={onClose}
        >
          Close
        </button>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Intent">
        {intents.map((row) => (
          <button
            key={row.id}
            type="button"
            role="radio"
            aria-checked={intent === row.id}
            className={`press relative min-h-11 rounded-full border px-4 text-callout font-medium transition-colors duration-fast ${
              intent === row.id ? "border-transparent text-fg" : "border-line-2 text-fg-3 hover:text-fg-2"
            }`}
            onClick={() => setIntent(row.id)}
          >
            {intent === row.id ? <motion.span layoutId="intent-pill" className="absolute inset-0 rounded-full bg-fill-3" transition={SPRING.snappy} /> : null}
            <span className="relative">{row.label}</span>
          </button>
        ))}
      </div>
      <AnimatePresence initial={false}>
        {intent === "task.reschedule" ? (
          <motion.label key="due" className="mb-3 block text-callout text-fg-2" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            New due date
            <input
              type="date"
              value={due}
              min={new Date().toLocaleDateString("en-CA")}
              onChange={(e) => setDue(e.target.value)}
              className={`${field} scheme-dark`}
            />
          </motion.label>
        ) : null}
        {intent === "task.block" ? (
          <motion.label key="blocker" className="mb-3 block text-callout text-fg-2" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
            Blocker
            <input value={blocker} onChange={(e) => setBlocker(e.target.value)} placeholder="Waiting on…" className={field} />
          </motion.label>
        ) : null}
      </AnimatePresence>
      <label className="mb-4 block text-callout text-fg-2">
        Note for {assistant}
        <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Optional context" className={`${field} resize-none`} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className="press flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full bg-accent-solid px-5 text-callout font-semibold text-white shadow-[0_4px_18px_rgb(var(--c-accent)/0.3)] disabled:opacity-50"
          onClick={() => void send(intent)}
        >
          {busy ? "Sending…" : `Send to ${assistant}`}
        </button>
        {isTask ? (
          <button
            type="button"
            disabled={busy}
            className="press flex min-h-11 items-center justify-center gap-2 rounded-full border border-line-2 px-5 text-callout font-medium text-fg hover:border-line-3 disabled:opacity-50"
            onClick={() => void send("task.complete")}
          >
            <CircleCheckIcon size={16} />
            Mark complete
          </button>
        ) : null}
      </div>
      {err ? (
        <p role="alert" className="mt-3 text-callout text-danger">
          {err}
        </p>
      ) : null}
    </div>
  );
}
