"use client";

import { useState } from "react";
import { CheckIcon } from "@/components/icons";
import { flagMessage, type Flag } from "@/lib/fleet-health";
import { showToast } from "@/lib/toast-store";
import { useAssistantName } from "@/lib/identity";
import { SEVERITY, SEVERITY_DOT } from "@/components/fleet-health";

/* Fleet Health → flags. */

export function FlagRow({ flag: f, onShowSkill, onSendToChief }: { flag: Flag; onShowSkill: (key: string) => void; onSendToChief?: (text: string) => Promise<void> }) {
  const assistant = useAssistantName();
  const [sending, setSending] = useState(false);
  const [asked, setAsked] = useState(false);
  const message = flagMessage(f);

  async function ask() {
    if (!onSendToChief || !message) return;
    setSending(true);
    try {
      await onSendToChief(message);
      setAsked(true);
    } catch (e) {
      showToast({ title: `Couldn't send to ${assistant}`, body: e instanceof Error ? e.message : "Try again", tone: "warn", icon: "alert" });
    } finally {
      setSending(false);
    }
  }

  return (
    <li className={`rounded-card border px-3.5 py-3 ${SEVERITY[f.severity] || SEVERITY.info}`}>
      <div className="flex items-start gap-2.5">
        <span className={`mt-[7px] size-2 shrink-0 rounded-full ${SEVERITY_DOT[f.severity] || SEVERITY_DOT.info}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-body font-medium text-fg">{f.title}</p>
          {f.detail ? <p className="mt-0.5 text-caption text-fg-3">{f.detail}</p> : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {f.skill ? (
              <button type="button" onClick={() => onShowSkill(f.skill!)} className="press inline-flex min-h-9 items-center rounded-full border border-line-2 px-3 text-caption font-medium text-fg-2 hover:text-fg">
                Show changes
              </button>
            ) : null}
            {message ? (
              <button
                type="button"
                disabled={!onSendToChief || sending || asked}
                onClick={() => void ask()}
                className="press inline-flex min-h-9 items-center gap-1.5 rounded-full bg-fg px-3 text-caption font-semibold text-canvas disabled:bg-fill-3 disabled:text-fg-3"
              >
                {asked ? <CheckIcon size={13} /> : null}
                {asked ? `Sent to ${assistant}` : sending ? "Sending…" : `Ask ${assistant}`}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}
