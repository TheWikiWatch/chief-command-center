"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Streamdown } from "streamdown";

import { BotFace, faceProps } from "@/components/bot-face";
import { PencilIcon, UserMinusIcon } from "@/components/icons";
import { AppearanceEditor } from "@/components/look/appearance-editor";
import { PetSprite } from "@/components/look/pet-sprite";
import { PersonaEditor } from "@/components/persona/persona-editor";
import { ModelPicker } from "@/components/fleet/model-picker";
import { NameEditor } from "@/components/persona/name-editor";
import { setAssistantTitle } from "@/lib/identity";
import { fleetApi } from "@/lib/fleet-client";
import { showToast } from "@/lib/toast-store";
import { ChiefPresence } from "@/components/presence";
import { Sheet } from "@/components/ui/sheet";
import { StatusPill } from "@/components/workforce-pane";
import { fetchPeek } from "@/lib/bridge";
import { EASE, SPRING } from "@/lib/motion";
import { splitTitle } from "@/lib/names";
import type { FaceLook, Peek, Person } from "@/lib/types";
import { LAYER } from "@/lib/layers";
import { btn } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/surface";

const TABS = ["Job", "Soul", "Memory", "Tools"] as const;
type Tab = (typeof TABS)[number];

/**
 * Look at one bot (VISUAL-OVERHAUL §5 #16). If the chief retires it while it is open, the drawer
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
    <Sheet open={open} onClose={() => setOpen(false)} side={full ? "bottom" : "right"} tall={full} bare scope={full ? "viewport" : "container"} zIndex={LAYER.drawer}>
      <LookBody person={person} name={name || person.name} role={role || person.section} retired={retired} onClose={() => setOpen(false)} />
    </Sheet>
  );
}

function LookBody({ person, name, role, retired, onClose }: { person: Person; name: string; role: string; retired: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("Job");
  const [peek, setPeek] = useState<Peek | null>(null);
  const [editing, setEditing] = useState(false);
  const [reload, setReload] = useState(0);
  // The name and role as just saved (the roster catches up on its next snapshot).
  const [shown, setShown] = useState({ name, role });
  useEffect(() => setShown({ name, role }), [name, role]);
  const [renaming, setRenaming] = useState(false);
  const [restyling, setRestyling] = useState(false);
  // The look as just saved (the roster catches up on its next snapshot); undefined until then.
  const [savedLook, setSavedLook] = useState<FaceLook | null | undefined>(undefined);
  useEffect(() => setSavedLook(undefined), [person.look]);
  const shownPerson: Person = savedLook === undefined ? person : { ...person, look: savedLook };

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
        {restyling ? (
          <button
            type="button"
            onClick={() => setRestyling(false)}
            className="press absolute left-3 top-2 min-h-11 rounded-full px-3 text-callout text-fg-2 hover:bg-fill-2 hover:text-fg"
          >
            Back
          </button>
        ) : !retired ? (
          <button
            type="button"
            onClick={() => {
              if (editing) setReload((n) => n + 1);
              setEditing((v) => !v);
            }}
            className="press absolute left-3 top-2 min-h-11 rounded-full px-3 text-callout text-fg-2 hover:bg-fill-2 hover:text-fg"
          >
            {editing ? "Done" : "Edit"}
          </button>
        ) : null}
        <button type="button" onClick={onClose} className="press absolute right-3 top-2 min-h-11 rounded-full px-3 text-callout text-fg-2 hover:bg-fill-2 hover:text-fg">
          Close
        </button>
        {restyling ? (
          // The editor shows the face itself: the header shrinks to a title so the options fit, on a phone too.
          <h2 className="flex min-h-11 items-center text-headline text-fg">{shown.name}&apos;s look</h2>
        ) : (
          <>
            <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1, transition: SPRING.bouncy }} className={`relative my-3 ${retired ? "opacity-50 grayscale" : ""}`}>
              {person.isChief ? <ChiefPresence chief={shownPerson} size={84} mood={person.ring === "working" ? "working" : "online"} /> : <BotFace {...faceProps(shownPerson)} size={88} />}
              {person.pet ? <PetSprite pet={person.pet} size={34} className="absolute -bottom-1 -right-9" /> : null}
            </motion.div>
            {!retired && !editing ? (
              <button
                type="button"
                onClick={() => setRestyling(true)}
                className="press -mt-1 mb-2 min-h-8 rounded-full px-3 text-caption font-medium text-fg-3 hover:bg-fill-2 hover:text-fg"
              >
                Change look
              </button>
            ) : null}
            {renaming ? (
              <NameEditor
                profile={person.isChief ? "chief" : person.id}
                name={shown.name}
                role={shown.role}
                onCancel={() => setRenaming(false)}
                onSaved={(res) => {
                  setShown({ name: res.name, role: res.role });
                  setRenaming(false);
                  if (person.isChief) setAssistantTitle(res.title);
                  showToast({
                    title: `Now called ${res.name}`,
                    body: res.soul.startsWith("kept") ? "The SOUL opens differently, so it was left as it is." : res.soul === "updated" ? "The SOUL uses the new name too." : undefined,
                    tone: "ok",
                    icon: "check",
                  });
                }}
              />
            ) : (
              <>
                <div className="group flex items-center gap-1.5">
                  <h2 className="text-display text-fg">{shown.name}</h2>
                  {!retired ? (
                    <button
                      type="button"
                      aria-label={`Rename ${shown.name}`}
                      title="Rename"
                      onClick={() => setRenaming(true)}
                      className="press grid size-9 place-items-center rounded-full text-fg-3 hover:bg-fill-2 hover:text-fg"
                    >
                      <PencilIcon size={16} />
                    </button>
                  ) : null}
                </div>
                {shown.role ? <p className="mt-1 text-body text-fg-3">{shown.role}</p> : null}
              </>
            )}
            <div className="mt-3">
              <StatusPill person={person} />
            </div>
          </>
        )}
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

      {restyling && !editing ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-2">
          <AppearanceEditor
            person={shownPerson}
            onDone={(look) => {
              setSavedLook(look);
              setRestyling(false);
            }}
          />
        </div>
      ) : editing ? (
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
              {tab === t ? <motion.span layoutId={`look-tab-${person.id}`} className="absolute inset-0 rounded-full bg-fill-3" transition={SPRING.snappy} /> : null}
              <span className="relative">{t}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8 pt-4">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE.enter } }} exit={{ opacity: 0, transition: { duration: 0.1 } }}>
            {!peek ? (
              <Skeleton lines={5} label="Reading" />
            ) : (
              <DrawerBody tab={tab} person={person} peek={peek} retired={retired} onRetired={onClose} onChanged={() => setReload((n) => n + 1)} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      </>
      )}
    </div>
  );
}

function DrawerBody({
  tab,
  person,
  peek,
  retired,
  onRetired,
  onChanged,
}: {
  tab: Tab;
  person: Person;
  peek: Peek;
  retired: boolean;
  onRetired: () => void;
  onChanged: () => void;
}) {
  if (!peek.ok) return <p className="text-body text-fg-3">Could not read this profile.</p>;
  if (tab === "Job") {
    const job = peek.job;
    const rows: [string, string][] = [
      ["Status", person.ring === "working" ? "Working" : person.ring === "failed" ? "Blocked" : "Idle"],
      ["Current or last job", job?.title || person.jobTitle || "None"],
      ["Kanban", job?.kanbanStatus || "—"],
      ["Flavor", peek.flavor?.flavor || person.flavor || "—"],
    ];
    return (
      <div className="space-y-4">
        {retired ? null : (
          <ModelPicker
            profile={person.isChief ? "chief" : person.id}
            provider={peek.model?.provider || ""}
            model={peek.model?.default || ""}
            onChanged={onChanged}
          />
        )}
        <dl className="divide-y divide-line overflow-hidden rounded-card border border-line bg-card">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-3 px-4 py-3">
              <dt className="w-32 shrink-0 text-callout text-fg-3">{k}</dt>
              <dd className="min-w-0 flex-1 wrap-break-word text-callout text-fg">{v}</dd>
            </div>
          ))}
        </dl>
        {peek.description ? <p className="whitespace-pre-wrap text-body text-fg-2">{peek.description}</p> : null}
        {!person.isChief && !retired ? <RetireRow person={person} onRetired={onRetired} /> : null}
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

/** Retire (unmint): archived, removed from the team, restorable from Fleet → Team. Always confirmed first. */
function RetireRow({ person, onRetired }: { person: Person; onRetired: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { name } = splitTitle(person.name);
  const who = name || person.name;
  if (!asking) {
    return (
      <button type="button" onClick={() => setAsking(true)} className="press min-h-10 rounded-full border border-line-2 px-4 text-callout text-fg-2 hover:text-fg">
        Retire {who}…
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-card border border-line-2 bg-card px-3 py-3">
      <p className="text-callout text-fg">
        Retire {who}? Their identity, memory and skills are archived and they leave the team. You can restore them any time from Fleet, then Team.
      </p>
      {person.ring === "working" ? <p className="text-callout text-warn">{who} is working on a task right now; retiring waits until it&apos;s done.</p> : null}
      {error ? (
        <p role="alert" className="text-callout text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || person.ring === "working"}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              const res = await fleetApi.retire(person.id);
              if (!res.ok) throw new Error(res.error || "Couldn't retire.");
              showToast({ title: `${who} was retired`, body: "Restore from Fleet, then Team", tone: "ok", icon: "user-minus" });
              onRetired();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Couldn't retire.");
            } finally {
              setBusy(false);
            }
          }}
          className={btn("primary", "md")}
        >
          {busy ? "Retiring…" : "Retire"}
        </button>
        <button type="button" onClick={() => setAsking(false)} className="press min-h-10 rounded-full border border-line-2 px-4 text-callout text-fg-2 hover:text-fg">
          Cancel
        </button>
      </div>
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
