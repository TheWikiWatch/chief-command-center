"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";

import { BotFace, faceProps } from "@/components/bot-face";
import { UserMinusIcon } from "@/components/icons";
import { PersonaEditor } from "@/components/persona/persona-editor";
import { ChiefPresence } from "@/components/presence";
import { Sheet } from "@/components/ui/sheet";
import { StatusPill } from "@/components/workforce-pane";
import { fetchPeek } from "@/lib/bridge";
import { EASE, SPRING } from "@/lib/motion";
import { splitTitle } from "@/lib/names";
import type { Peek, Person } from "@/lib/types";

const TABS = ["Job", "Soul", "Memory", "Tools"] as const;
type Tab = (typeof TABS)[number];

/**
 * Look at one bot (VISUAL-OVERHAUL §5 #16). If Chief retires it while it is open, the drawer
 * says so and closes itself (§12).
 */
export function LookDrawer({
  person,
  onClose,
  full = false,
  retired = false,
}: {
  person: Person;
  onClose: () => void;
  full?: boolean;
  retired?: boolean;
}) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (!retired) return;
    const t = window.setTimeout(() => setOpen(false), 1800);
    return () => window.clearTimeout(t);
  }, [retired]);
  useEffect(() => {
    if (open) return;
    const t = window.setTimeout(onClose, 320);
    return () => window.clearTimeout(t);
  }, [open, onClose]);

  const { name, role } = splitTitle(person.name);
  return (
    <Sheet open={open} onClose={() => setOpen(false)} side={full ? "bottom" : "right"} tall={full} bare scope={full ? "viewport" : "container"} zIndex={90}>
      <LookBody person={person} name={name || person.name} role={role || person.section} retired={retired} onClose={() => setOpen(false)} />
    </Sheet>
  );
}

function LookBody({ person, name, role, retired, onClose }: { person: Person; name: string; role: string; retired: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("Job");
  const [peek, setPeek] = useState<Peek | null>(null);
  const [editing, setEditing] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let alive = true;
    setPeek(null);
    setTab("Job");
    fetchPeek(person.id)
      .then((data) => {
        if (alive) setPeek(data);
      })
      .catch(() => {
        if (alive) setPeek({ ok: false });
      });
    return () => {
      alive = false;
    };
  }, [person.id, reload]);

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex flex-col items-center px-5 pb-4 pt-3 text-center">
        {!retired ? (
          <button
            type="button"
            onClick={() => {
              if (editing) setReload((n) => n + 1);
              setEditing((v) => !v);
            }}
            className="press absolute left-3 top-2 min-h-11 rounded-full px-3 text-callout text-fg-2 hover:bg-white/[0.06] hover:text-fg"
          >
            {editing ? "Done" : "Edit"}
          </button>
        ) : null}
        <button type="button" onClick={onClose} className="press absolute right-3 top-2 min-h-11 rounded-full px-3 text-callout text-fg-2 hover:bg-white/[0.06] hover:text-fg">
          Close
        </button>
        <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: SPRING.bouncy }} className={`my-3 ${retired ? "opacity-50 grayscale" : ""}`}>
          {person.isChief ? <ChiefPresence chief={person} size={84} mood={person.ring === "working" ? "working" : "online"} /> : <BotFace {...faceProps(person)} size={88} />}
        </motion.div>
        <h2 className="text-display text-fg">{name}</h2>
        {role ? <p className="mt-1 text-body text-fg-3">{role}</p> : null}
        <div className="mt-3">
          <StatusPill person={person} />
        </div>
        <AnimatePresence>
          {retired ? (
            <motion.p
              role="status"
              className="mt-3 flex items-center gap-2 rounded-full border border-line-2 bg-card px-3 py-1.5 text-callout text-fg-2"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0, transition: { duration: 0.24, ease: EASE.enter } }}
            >
              <UserMinusIcon size={15} />
              {name} was retired
            </motion.p>
          ) : null}
        </AnimatePresence>
      </div>

      {editing ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-2">
          <PersonaEditor profile={person.id} name={name} />
        </div>
      ) : (
      <>
      <div className="px-4">
        <div className="flex gap-1 rounded-full border border-line bg-card p-1" role="tablist" aria-label="Details">
          {TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`relative min-h-9 flex-1 rounded-full text-callout font-medium transition-colors duration-fast ${tab === t ? "text-fg" : "text-fg-3 hover:text-fg-2"}`}
            >
              {tab === t ? <motion.span layoutId={`look-tab-${person.id}`} className="absolute inset-0 rounded-full bg-white/10" transition={SPRING.snappy} /> : null}
              <span className="relative">{t}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-4">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE.enter } }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
            {!peek ? <p className="shimmer-text text-body">Reading…</p> : <DrawerBody tab={tab} person={person} peek={peek} />}
          </motion.div>
        </AnimatePresence>
      </div>
      </>
      )}
    </div>
  );
}

function DrawerBody({ tab, person, peek }: { tab: Tab; person: Person; peek: Peek }) {
  if (!peek.ok) return <p className="text-body text-fg-3">Could not read this profile.</p>;
  if (tab === "Job") {
    const job = peek.job;
    const rows: [string, string][] = [
      ["Status", person.ring === "working" ? "Working" : person.ring === "failed" ? "Blocked" : "Idle"],
      ["Current or last job", job?.title || person.jobTitle || "None"],
      ["Kanban", job?.kanbanStatus || "—"],
      ["Model", peek.model?.default ? `${peek.model.provider || ""} / ${peek.model.default}` : person.model || "—"],
      ["Flavor", peek.flavor?.flavor || person.flavor || "—"],
    ];
    return (
      <div className="space-y-4">
        <dl className="divide-y divide-line overflow-hidden rounded-card border border-line bg-card">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-3 px-4 py-3">
              <dt className="w-32 shrink-0 text-callout text-fg-3">{k}</dt>
              <dd className="min-w-0 flex-1 break-words text-callout text-fg">{v}</dd>
            </div>
          ))}
        </dl>
        {peek.description ? <p className="whitespace-pre-wrap text-body text-fg-2">{peek.description}</p> : null}
      </div>
    );
  }
  if (tab === "Soul") {
    return peek.soul ? <Streamdown className="chat-md text-body">{peek.soul}</Streamdown> : <p className="text-body text-fg-3">No SOUL.md yet.</p>;
  }
  if (tab === "Memory") {
    return (
      <div className="space-y-6">
        <section>
          <h3 className="mb-2 font-mono text-code text-fg-3">MEMORY.md</h3>
          {peek.memory ? <Streamdown className="chat-md text-body">{peek.memory}</Streamdown> : <p className="text-body text-fg-3">Empty.</p>}
        </section>
        {peek.userMemory ? (
          <section>
            <h3 className="mb-2 font-mono text-code text-fg-3">USER.md</h3>
            <Streamdown className="chat-md text-body">{peek.userMemory}</Streamdown>
          </section>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <Chips title="Toolsets" items={peek.toolsets || []} />
      <Chips title="Skills" items={peek.skills || []} />
    </div>
  );
}

function Chips({ title, items }: { title: string; items: string[] }) {
  return (
    <section>
      <h3 className="mb-2 text-callout font-medium text-fg-2">
        {title} <span className="text-fg-3">{items.length}</span>
      </h3>
      {items.length ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <motion.span
              key={item}
              className="rounded-chip border border-line-2 bg-card px-2 py-1 font-mono text-code text-fg-2"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0, transition: { delay: Math.min(i, 12) * 0.02, duration: 0.2 } }}
            >
              {item}
            </motion.span>
          ))}
        </div>
      ) : (
        <p className="text-callout text-fg-3">—</p>
      )}
    </section>
  );
}
