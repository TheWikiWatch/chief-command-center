"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { CheckIcon, ChevronRightIcon, CircleCheckIcon } from "@/components/icons";
import { btn } from "@/components/ui/button";
import { ackFlag, flagMessage, type Flag } from "@/lib/fleet-health";
import { SPRING } from "@/lib/motion";
import { showToast } from "@/lib/toast-store";
import { useAssistantName } from "@/lib/identity";
import { SEVERITY, SEVERITY_DOT, agoAt } from "@/components/fleet-health";

/* Fleet Health → flags: what needs a look, and what the owner already looked at (hidden until something new). */

export type FlagMove = "hide" | "show";


/** How long an acknowledgement holds, in the owner's words. */
const holds = (f: Flag) => (f.evidenceAt === null ? "Hidden for a week" : "Hidden until something new happens");

export function FlagRow({
  flag: f,
  onShowSkill,
  onSendToChief,
  onMoved,
}: {
  flag: Flag;
  onShowSkill: (key: string) => void;
  onSendToChief?: (text: string) => Promise<void>;
  onMoved?: (flag: Flag, move: FlagMove) => void;
}) {
  const assistant = useAssistantName();
  const [busy, setBusy] = useState<"" | "fine" | "ask">("");
  const message = flagMessage(f);

  async function fine() {
    setBusy("fine");
    try {
      const res = await ackFlag(f, "fine");
      if (!res.ok) throw new Error(res.error || "Try again");
      onMoved?.(f, "hide");
      showToast({ title: "Marked fine", body: `${holds(f)}.`, tone: "ok", icon: "check" });
    } catch (e) {
      showToast({ title: "Couldn't save that", body: e instanceof Error ? e.message : "Try again", tone: "warn", icon: "alert" });
    } finally {
      setBusy("");
    }
  }

  async function ask() {
    if (!onSendToChief || !message) return;
    setBusy("ask");
    try {
      await onSendToChief(message);
    } catch (e) {
      setBusy("");
      showToast({ title: `Couldn't send to ${assistant}`, body: e instanceof Error ? e.message : "Try again", tone: "warn", icon: "alert" });
      return;
    }
    // Sent: record it, so the chief's tidy-up isn't counted against the skill and the flag steps aside.
    await ackFlag(f, "asked").catch(() => null);
    setBusy("");
    onMoved?.(f, "hide");
    showToast({
      title: `Sent to ${assistant}`,
      body: "Its tidy-up won't count against the skill.",
      tone: "ok",
      icon: "check",
    });
  }

  return (
    <motion.li layout="position" exit={{ opacity: 0, height: 0, transition: { duration: 0.16 } }} className={`rounded-card border px-3.5 py-3 ${SEVERITY[f.severity] || SEVERITY.info}`}>
      <div className="flex items-start gap-2.5">
        <span className={`mt-[7px] size-2 shrink-0 rounded-full ${SEVERITY_DOT[f.severity] || SEVERITY_DOT.info}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-fg">{f.title}</p>
          {f.detail ? <p className="mt-0.5 text-caption text-fg-3">{f.detail}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {f.skill ? (
              <button type="button" onClick={() => onShowSkill(f.skill!)} className={btn("secondary", "sm")}>
                Show changes
              </button>
            ) : null}
            {f.kind !== "proposal" ? (
              <button type="button" onClick={() => void fine()} disabled={!!busy} className={btn("secondary", "sm")}>
                <CheckIcon size={13} />
                {busy === "fine" ? "Saving…" : "Looks fine"}
              </button>
            ) : null}
            {message ? (
              <button
                type="button"
                disabled={!onSendToChief || !!busy}
                onClick={() => void ask()}
                className={btn("primary", "sm")}
              >
                {busy === "ask" ? "Sending…" : `Ask ${assistant}`}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </motion.li>
  );
}

/** Flags the owner marked fine or asked the chief about: folded away, each one tap from coming back. */
export function LookedAt({ flags, onMoved }: { flags: Flag[]; onMoved?: (flag: Flag, move: FlagMove) => void }) {
  const assistant = useAssistantName();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  if (!flags.length) return null;

  async function showAgain(f: Flag) {
    setBusy(f.id);
    try {
      const res = await ackFlag(f, "clear");
      if (!res.ok) throw new Error(res.error || "Try again");
      onMoved?.(f, "show");
    } catch (e) {
      showToast({ title: "Couldn't bring it back", body: e instanceof Error ? e.message : "Try again", tone: "warn", icon: "alert" });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="press flex min-h-9 w-full items-center gap-1.5 rounded-ctl px-1 text-left text-caption text-fg-3 hover:text-fg-2"
      >
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={SPRING.snappy} className="text-fg-4">
          <ChevronRightIcon size={14} />
        </motion.span>
        Looked at · {flags.length}
        <span className="ml-auto hidden truncate sm:inline">Hidden until something new happens</span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: SPRING.gentle }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.16 } }}
            className="overflow-hidden"
          >
            {flags.map((f) => (
              <li key={f.id} className="mt-1.5 flex items-center gap-3 rounded-card border border-line bg-card px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-callout text-fg-2">{f.title}</span>
                  <span className="block truncate text-caption text-fg-3">
                    {f.ack?.action === "asked" ? `Asked ${assistant}` : "Marked fine"} · {agoAt(f.ack?.at)}
                  </span>
                </span>
                <button type="button" onClick={() => void showAgain(f)} disabled={busy === f.id} className={btn("secondary", "sm", "shrink-0")}>
                  {busy === f.id ? "…" : "Show again"}
                </button>
              </li>
            ))}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Nothing needs a look: said plainly, with what the owner already looked at folded underneath. */
export function AllClear() {
  return (
    <div className="flex items-center gap-2.5 rounded-card border border-line bg-card px-3.5 py-3">
      <span className="text-ok">
        <CircleCheckIcon size={18} />
      </span>
      <span className="text-callout text-fg-2">Nothing needs a look right now.</span>
    </div>
  );
}
