"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { BotFace, faceProps } from "@/components/bot-face";
import { ClockIcon, XIcon } from "@/components/icons";
import {
  detectPromise,
  followedUp,
  newestId,
  PROMISE_WAIT_MS,
  removeFollowup,
  updateFollowups,
  useFollowups,
  addFollowup,
  type Followup,
} from "@/lib/followups";
import { fx } from "@/lib/fx";
import { readFx } from "@/lib/fx-prefs";
import { SPRING } from "@/lib/motion";
import type { ChatMessage, Person } from "@/lib/types";
import { useAssistantName } from "@/lib/identity";

/**
 * Keeps the follow-up reminders honest (PLAN-2026-09-23 §2): starts promise reminders from Chief's
 * replies, clears any reminder once Chief follows up, and reveals the rest when they come due.
 * `primed` is false until the first transcript has loaded, so history never starts a reminder.
 */
export function useFollowupWatch(messages: ChatMessage[], { primed, busy }: { primed: boolean; busy: boolean }) {
  const items = useFollowups();
  const scanned = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (!primed) return;
    const newest = newestId(messages);
    // History at load time is never scanned for promises.
    if (scanned.current === null) scanned.current = newest;
    const fresh = messages.filter((m) => m.id > (scanned.current as number) && m.id < 1e12);
    scanned.current = Math.max(scanned.current, newest);

    const promise = [...fresh].reverse().find((m) => m.role === "assistant" && detectPromise(String(m.content || "")));
    if (promise && readFx().promises) {
      const sentence = detectPromise(String(promise.content || "")) || "";
      updateFollowups((list) => [
        ...list.filter((f) => f.kind !== "promise"),
        { id: `promise:${promise.id}`, kind: "promise", title: sentence, createdAt: Date.now(), dueAt: Date.now() + PROMISE_WAIT_MS, afterId: promise.id, shown: false },
      ]);
    }

    updateFollowups((list) => {
      let changed = false;
      const next = list
        .map((f) => {
          if (f.afterId !== null) return f;
          changed = true;
          return { ...f, afterId: newest };
        })
        .filter((f) => {
          const done = followedUp(f, messages);
          if (done) changed = true;
          return !done;
        });
      return changed ? next : list;
    });
  }, [messages, primed, items.length]);

  // Reveal reminders that came due, but never while Chief is mid-turn (he may be on it right now).
  useEffect(() => {
    if (busy) return;
    const due = items.filter((f) => !f.shown && f.afterId !== null && now >= f.dueAt);
    if (!due.length) return;
    updateFollowups((list) => list.map((f) => (due.some((d) => d.id === f.id) ? { ...f, shown: true } : f)));
    fx("followup");
  }, [items, now, busy]);

  return items.filter((f) => f.shown);
}

/** Start a reminder when a specialist finishes a job (called from the fleet's roster moments). */
export function noteFinishedJob(person: Person, jobTitle: string, who: string) {
  if (person.isChief || !readFx().nudges) return;
  const title = jobTitle.trim() || "their task";
  addFollowup({
    id: `finished:${person.id}:${title}`,
    kind: "finished",
    who,
    whoId: person.id,
    title,
    createdAt: Date.now(),
    dueAt: Date.now() + 3 * 60_000,
  });
}

function ago(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min}m ago` : `${Math.round(min / 60)}h ago`;
}

/** The ask that goes to Chief when you tap the card's button. */
export function followupAsk(item: Followup) {
  return item.kind === "finished"
    ? `${item.who || "A specialist"} just finished "${item.title}". Please review it and follow up with me.`
    : `You said you'd check back ("${item.title}"). Any update?`;
}

export function FollowupCards({
  items,
  people,
  chief,
  disabled,
  onAsk,
}: {
  items: Followup[];
  people: Person[];
  chief: Person | undefined;
  disabled: boolean;
  onAsk: (item: Followup) => Promise<void>;
}) {
  const assistant = useAssistantName();
  const [sending, setSending] = useState<string | null>(null);
  const visible = items.slice(-2);
  const more = items.length - visible.length;
  return (
    <div className="space-y-2 empty:hidden" aria-live="polite">
      <AnimatePresence initial={false}>
        {visible.map((item) => {
          const bot = item.kind === "finished" ? people.find((p) => p.id === item.whoId) : chief;
          return (
            <motion.div
              key={item.id}
              layout
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING.bouncy }}
              exit={{ opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.16 } }}
              className="flex items-start gap-3 rounded-card border border-line-2 bg-raised px-3 pb-2.5 pt-3 shadow-e3"
              role="status"
            >
              <div className="mt-0.5 shrink-0">
                {bot ? <BotFace {...faceProps(bot)} size={34} still /> : <span className="grid size-[34px] place-items-center rounded-full bg-white/[0.06] text-fg-2"><ClockIcon size={17} /></span>}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-callout text-fg">
                  {item.kind === "finished" ? (
                    <>
                      <span className="font-semibold">{item.who}</span> finished <span className="text-fg-3">· {ago(Date.now() - item.createdAt)}</span>
                    </>
                  ) : (
                    <>
                      <span className="font-semibold">{assistant} said they&apos;d check back</span> <span className="text-fg-3">· {ago(Date.now() - item.createdAt)}</span>
                    </>
                  )}
                </p>
                <p className="mt-0.5 line-clamp-1 text-callout text-fg-2" title={item.title}>{item.kind === "finished" ? item.title : `“${item.title}”`}</p>
                <div className="mt-2 flex items-center gap-3">
                  <button
                    type="button"
                    disabled={disabled || sending === item.id}
                    onClick={() => {
                      setSending(item.id);
                      void onAsk(item)
                        .then(() => removeFollowup(item.id))
                        .catch(() => undefined)
                        .finally(() => setSending(null));
                    }}
                    className="press min-h-11 shrink-0 rounded-full bg-fg px-4 text-callout font-semibold text-canvas disabled:bg-white/10 disabled:text-fg-3"
                  >
                    {sending === item.id ? "Asking…" : item.kind === "finished" ? `Ask ${assistant}` : "Ask for an update"}
                  </button>
                  <span className="min-w-0 truncate text-caption text-fg-3">
                    {item.kind === "finished" ? `No word from ${assistant}` : "No word since"}
                    {more > 0 ? ` · +${more} more` : ""}
                  </span>
                </div>
              </div>
              <button
                type="button"
                aria-label="Dismiss reminder"
                onClick={() => removeFollowup(item.id)}
                className="press -mr-1 -mt-1 grid size-9 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-white/[0.06] hover:text-fg"
              >
                <XIcon size={16} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
