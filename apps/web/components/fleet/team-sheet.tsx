"use client";

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { CircleAlertIcon, CircleCheckIcon, PlusIcon, UsersIcon } from "@/components/icons";
import { Sheet } from "@/components/ui/sheet";
import { fleetApi, type Archive } from "@/lib/fleet-client";
import { useAssistantName } from "@/lib/identity";

/**
 * Fleet → Team: ask the chief for a new specialist (it interviews, drafts a SOUL and waits for your
 * sign-off before minting), and the retired bots, which can be restored or removed for good.
 */
export function TeamButton({ phone, onAskChief }: { phone: boolean; onAskChief: (text: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <>
      {phone ? (
        <button type="button" aria-label="Team" title="Team" onClick={() => setOpen(true)} className="press grid size-11 shrink-0 place-items-center rounded-full text-fg-2 hover:bg-white/[0.06] hover:text-fg">
          <UsersIcon size={19} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="press flex min-h-11 items-center gap-2 rounded-full border border-line-2 bg-pane/90 px-4 text-callout font-medium text-fg shadow-e3 backdrop-blur hover:border-line-3"
        >
          <UsersIcon size={17} />
          Team
        </button>
      )}
      {/* The button sits inside the Fleet pane's header layer; the sheet goes to the body so it covers the whole window. */}
      {!mounted
        ? null
        : createPortal(
            <Sheet open={open} onClose={() => setOpen(false)} title="Team" subtitle="Your specialists, new and retired." side={phone ? "bottom" : "right"} tall>
              <TeamBody
                onAskChief={async (text) => {
                  await onAskChief(text);
                  setOpen(false);
                }}
              />
            </Sheet>,
            document.body,
          )}
    </>
  );
}

export function TeamBody({ onAskChief }: { onAskChief: (text: string) => Promise<void> }) {
  const assistant = useAssistantName();
  const fieldId = useId();
  const [need, setNeed] = useState("");
  const [asking, setAsking] = useState(false);
  const [archives, setArchives] = useState<Archive[] | null>(null);
  const [busyId, setBusyId] = useState("");
  const [confirmRemove, setConfirmRemove] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(() => {
    fleetApi
      .roster()
      .then((r) => (r.ok ? setArchives(r.archives) : setNote({ tone: "error", text: r.error || "Couldn't read the team." })))
      .catch((e: unknown) => setNote({ tone: "error", text: e instanceof Error ? e.message : "Couldn't read the team." }));
  }, []);
  useEffect(load, [load]);

  async function act(id: string, fn: () => Promise<{ ok: boolean; error?: string }>, done: string) {
    setBusyId(id);
    setNote(null);
    try {
      const res = await fn();
      setNote(res.ok ? { tone: "ok", text: done } : { tone: "error", text: res.error || "That didn't work." });
      load();
    } catch (e) {
      setNote({ tone: "error", text: e instanceof Error ? e.message : "That didn't work." });
    } finally {
      setBusyId("");
      setConfirmRemove("");
    }
  }

  return (
    <div className="space-y-6 px-4 pb-10 pt-3">
      <section className="space-y-2">
        <h3 className="flex items-center gap-2 text-body font-medium text-fg">
          <PlusIcon size={16} className="text-fg-3" />
          Propose a specialist
        </h3>
        <p className="text-callout text-fg-3">
          Describe the recurring work. {assistant} will ask a few questions, draft the bot&apos;s identity and show it to you; nothing is created until you say yes.
        </p>
        <label htmlFor={fieldId} className="sr-only">
          What should the new specialist do?
        </label>
        <textarea
          id={fieldId}
          rows={3}
          value={need}
          onChange={(e) => setNeed(e.target.value)}
          placeholder="e.g. Keep an eye on my supplier invoices and flag anything odd"
          className="w-full resize-none rounded-ctl border border-line-2 bg-canvas px-3 py-2 text-body text-fg outline-none placeholder:text-fg-3 focus:border-line-3"
        />
        <button
          type="button"
          disabled={!need.trim() || asking}
          onClick={async () => {
            setAsking(true);
            try {
              await onAskChief(`I'd like a new specialist for this: ${need.trim()}\n\nPlease use your fleet-builder skill: interview me, then draft the SOUL for me to sign before you mint anything.`);
              setNeed("");
            } catch (e) {
              setNote({ tone: "error", text: e instanceof Error ? e.message : `Couldn't reach ${assistant}.` });
            } finally {
              setAsking(false);
            }
          }}
          className="press min-h-11 w-full rounded-full bg-fg px-5 text-callout font-semibold text-canvas disabled:opacity-50"
        >
          {asking ? "Sending…" : `Ask ${assistant}`}
        </button>
      </section>

      <section className="space-y-2">
        <h3 className="text-body font-medium text-fg">Retired</h3>
        {archives === null ? <p className="text-callout text-fg-3">Loading…</p> : null}
        {archives && !archives.length ? <p className="text-callout text-fg-3">No retired bots. A retired bot is archived (its identity, memory and skills) and can be brought back.</p> : null}
        {archives?.length ? (
          <ul className="divide-y divide-line overflow-hidden rounded-card border border-line">
            {archives.map((a) => (
              <li key={a.id} className="space-y-2 px-3 py-3">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body text-fg">{a.title}</p>
                    <p className="text-caption text-fg-3">Retired {new Date(a.retired_at).toLocaleDateString()}</p>
                  </div>
                  <Small disabled={!!busyId} onClick={() => void act(a.id, () => fleetApi.restore(a.id), `${a.title} is back on the team.`)}>
                    {busyId === a.id ? "Working…" : "Restore"}
                  </Small>
                  <Small subtle disabled={!!busyId} onClick={() => setConfirmRemove(confirmRemove === a.id ? "" : a.id)}>
                    Remove…
                  </Small>
                </div>
                {confirmRemove === a.id ? (
                  <div className="space-y-2 rounded-card border border-danger/30 bg-danger/[0.06] px-3 py-2">
                    <p className="text-callout text-fg">Remove {a.title}&apos;s archive for good? Its identity, memory and history can&apos;t be brought back after this.</p>
                    <div className="flex gap-2">
                      <Small danger disabled={!!busyId} onClick={() => void act(a.id, () => fleetApi.removeArchive(a.id), `${a.title}'s archive was removed.`)}>
                        Remove for good
                      </Small>
                      <Small subtle onClick={() => setConfirmRemove("")}>
                        Keep it
                      </Small>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {note ? <Note tone={note.tone}>{note.text}</Note> : null}
    </div>
  );
}

function Small({ children, onClick, disabled, subtle, danger }: { children: ReactNode; onClick: () => void; disabled?: boolean; subtle?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`press min-h-10 shrink-0 rounded-full px-3.5 text-callout font-medium disabled:opacity-50 ${
        danger ? "bg-danger text-white" : subtle ? "border border-line-2 text-fg-2 hover:text-fg" : "bg-fg text-canvas"
      }`}
    >
      {children}
    </button>
  );
}

function Note({ tone, children }: { tone: "ok" | "error"; children: ReactNode }) {
  const Icon = tone === "ok" ? CircleCheckIcon : CircleAlertIcon;
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-2 text-callout ${tone === "error" ? "text-danger" : "text-fg-2"}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone === "ok" ? "text-ok" : ""}`} />
      <span>{children}</span>
    </p>
  );
}
