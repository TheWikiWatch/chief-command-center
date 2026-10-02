"use client";

import { AnimatePresence, motion } from "motion/react";

import { BotFace, faceProps } from "@/components/bot-face";
import { SparklesIcon } from "@/components/icons";
import { activityVerb, useFleetActivity } from "@/lib/fleet-activity";
import { useAssistantName } from "@/lib/identity";
import { EASE } from "@/lib/motion";
import { splitTitle } from "@/lib/names";
import type { Person } from "@/lib/types";

/* The Fleet beside the orbit (a wide desktop pane): the crew at a glance, and what happened this session. */

/** Ideas for a first specialist; picking one fills the message box (never sends). */
export const SPECIALIST_IDEAS = [
  { label: "A researcher", ask: "Bring on a researcher who digs into questions for me and reports back with sources." },
  { label: "A writer", ask: "Bring on a writer who drafts my e-mails, posts and replies in my voice." },
  { label: "A planner", ask: "Bring on a planner who keeps an eye on my week and tells me what to do first." },
] as const;

/** A Fleet with fewer than two specialists: an invitation to bring one on. */
export function FleetInvite({ onAsk, floating = false }: { onAsk: (text: string) => void; floating?: boolean }) {
  const assistant = useAssistantName();
  return (
    <motion.div
      className={floating ? "w-[min(30rem,calc(100%-2rem))] rounded-sheet border border-line-2 bg-raised/95 p-4 shadow-e3" : "rounded-card border border-line bg-card p-4"}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, transition: { delay: 0.5, duration: 0.36, ease: EASE.enter } }}
    >
      <p className="flex items-center gap-2 text-headline text-fg">
        <SparklesIcon size={17} className="text-accent-text" />
        Ask {assistant} to bring on a specialist
      </p>
      <p className="mt-1 text-callout text-fg-3">A specialist takes one kind of work off your plate, and {assistant} hands it over.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {SPECIALIST_IDEAS.map((idea) => (
          <button
            key={idea.label}
            type="button"
            className="press min-h-10 rounded-full border border-line-2 bg-fill-1 px-3.5 text-callout text-fg hover:border-line-3 hover:bg-fill-2"
            onClick={() => onAsk(idea.ask)}
          >
            {idea.label}
          </button>
        ))}
      </div>
    </motion.div>
  );
}

function clock(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function FleetSide({ chief, specialists, onOpen }: { chief: Person | undefined; specialists: Person[]; onOpen: (p: Person) => void }) {
  const assistant = useAssistantName();
  const activity = useFleetActivity();
  const crew = [...specialists].sort((a, b) => Number(b.ring === "working") - Number(a.ring === "working") || a.name.localeCompare(b.name));
  const byId = new Map([...(chief ? [chief] : []), ...specialists].map((p) => [p.id, p]));

  return (
    <aside aria-label="Crew and activity" className="flex h-full w-80 shrink-0 flex-col border-l border-line bg-pane">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-6 pt-16">
        <h2 className="mb-1 flex items-baseline gap-2 px-2 text-headline text-fg">
          Crew <span className="font-mono text-code tabular text-fg-3">{specialists.length}</span>
        </h2>
        {crew.length === 0 ? <p className="px-2 py-2 text-callout text-fg-3">No specialists yet.</p> : null}
        <ul className="mb-6" aria-label="Crew">
          {crew.map((person) => {
            const { name, role } = splitTitle(person.name);
            const status = person.ring === "working" ? person.jobTitle || "Working" : person.ring === "failed" ? "Blocked" : role || "Ready";
            return (
              <li key={person.id}>
                <button type="button" onClick={() => onOpen(person)} className="press flex min-h-12 w-full items-center gap-2.5 rounded-ctl px-2 text-left hover:bg-fill-1">
                  <BotFace {...faceProps(person)} size={30} still />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-callout font-medium text-fg">{name || person.name}</span>
                    <span className={`block truncate text-caption ${person.ring === "working" ? "text-accent-text" : person.ring === "failed" ? "text-danger" : "text-fg-3"}`}>{status}</span>
                  </span>
                  {person.ring === "working" ? <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" aria-hidden /> : null}
                </button>
              </li>
            );
          })}
        </ul>

        <h2 className="mb-1 px-2 text-headline text-fg">Activity</h2>
        {activity.length === 0 ? (
          <p className="px-2 py-2 text-callout text-fg-3">Nothing yet this session. When {assistant} hands out work, it shows here.</p>
        ) : (
          <ol className="relative ml-[1.15rem] border-l border-line pl-4" aria-label="Activity">
            <AnimatePresence initial={false}>
              {activity.map((item) => {
                const person = byId.get(item.personId);
                return (
                  <motion.li
                    key={item.key}
                    className="relative py-2"
                    initial={{ opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0, transition: { duration: 0.24, ease: EASE.enter } }}
                  >
                    <span
                      aria-hidden
                      className={`absolute -left-[1.3rem] top-3.5 size-2 rounded-full ring-4 ring-(--color-pane) ${item.kind === "dispatched" ? "bg-accent" : item.kind === "finished" ? "bg-ok" : item.kind === "retired" ? "bg-fg-3" : "bg-fg-2"}`}
                    />
                    <p className="text-callout text-fg-2">
                      {person ? (
                        <button type="button" className="press font-medium text-fg hover:underline" onClick={() => onOpen(person)}>
                          {item.who}
                        </button>
                      ) : (
                        <span className="font-medium text-fg">{item.who}</span>
                      )}{" "}
                      {activityVerb(item.kind, assistant)}
                    </p>
                    {item.detail ? <p className="truncate text-caption text-fg-3">{item.detail}</p> : null}
                    <p className="font-mono text-micro tabular text-fg-3">{clock(item.at)}</p>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ol>
        )}
      </div>
    </aside>
  );
}
