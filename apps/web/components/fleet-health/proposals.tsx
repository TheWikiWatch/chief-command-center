"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { CheckIcon, XIcon } from "@/components/icons";
import { approvalMessage, decideProposal, type Proposal } from "@/lib/fleet-health";
import { EASE } from "@/lib/motion";
import { showToast } from "@/lib/toast-store";
import { useAssistantName } from "@/lib/identity";
import { btn } from "@/components/ui/button";
import { LEGACY_DISMISSED_KEY, STATUS } from "@/components/fleet-health";
import { EmptyCard } from "@/components/fleet-health/parts";

/* Fleet Health → the weekly proposals the owner approves or dismisses. */

export function takeLegacyDismissed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(LEGACY_DISMISSED_KEY) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** An older external ledger wrote the chief's own name ("sent to Nova"); any name reads as the chief. */
export const statusKey = (s: string) => (/^waiting on /i.test(s) ? "waiting on the chief" : /^sent to /i.test(s) ? "sent to the chief" : s);

export function Proposals({ items, onSendToChief, onDecided }: { items: Proposal[]; onSendToChief?: (text: string) => Promise<void>; onDecided: () => void }) {
  const assistant = useAssistantName();
  const [sending, setSending] = useState<string | null>(null);
  // Decided here, before the next poll brings the server's status.
  const [local, setLocal] = useState<Record<string, "approve" | "dismiss">>({});
  const [showDecided, setShowDecided] = useState(false);

  // Proposals dismissed on this device before decisions were shared: record them for every device, once.
  useEffect(() => {
    const legacy = takeLegacyDismissed().filter((id) => items.some((p) => p.id === id && (!p.status || p.status === "open")));
    if (!legacy.length) {
      if (items.length) {
        try {
          localStorage.removeItem(LEGACY_DISMISSED_KEY);
        } catch {
          /* private mode */
        }
      }
      return;
    }
    void Promise.all(legacy.map((id) => decideProposal(id, "dismiss"))).then(() => {
      try {
        localStorage.removeItem(LEGACY_DISMISSED_KEY);
      } catch {
        /* private mode */
      }
      onDecided();
    }, () => undefined);
  }, [items, onDecided]);

  const statusOf = (p: Proposal) => (local[p.id] ? (local[p.id] === "approve" ? "sent to the chief" : "dismissed") : p.status || "open");
  const open = items.filter((p) => statusOf(p) === "open");
  const decided = items.filter((p) => statusOf(p) !== "open");

  async function decide(p: Proposal, decision: "approve" | "dismiss") {
    setSending(p.id);
    try {
      if (decision === "approve") {
        if (!onSendToChief) return;
        await onSendToChief(approvalMessage(p));
      }
      setLocal((m) => ({ ...m, [p.id]: decision }));
      const res = await decideProposal(p.id, decision);
      if (!res.ok) throw new Error(res.error || "Couldn't save the decision");
      onDecided();
    } catch (e) {
      showToast({ title: decision === "approve" ? `Couldn't send to ${assistant}` : "Couldn't dismiss", body: e instanceof Error ? e.message : "Try again", tone: "warn", icon: "alert" });
    } finally {
      setSending(null);
    }
  }

  return (
    <>
      {open.length ? (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {open.map((p) => (
              <motion.li
                key={p.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE.enter } }}
                exit={{ opacity: 0, height: 0, transition: { duration: 0.18 } }}
                className="rounded-card border border-line bg-card px-3.5 py-3"
              >
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 rounded-full bg-fill-2 px-1.5 py-0.5 text-caption font-medium text-fg-2">{p.kind}</span>
                  <span className="truncate text-body font-medium text-fg">{p.target}</span>
                </div>
                <p className="mt-1.5 text-callout text-fg">{p.change}</p>
                {p.why ? <p className="mt-1 text-caption text-fg-3">Why: {p.why}</p> : null}
                <div className="mt-3 flex items-center gap-2">
                  <button
                    type="button"
                    disabled={!onSendToChief || sending === p.id}
                    onClick={() => void decide(p, "approve")}
                    className={btn("primary", "md", "inline-flex items-center gap-1.5 disabled:text-fg-3")}
                  >
                    <CheckIcon size={15} />
                    {sending === p.id ? "Sending…" : "Approve"}
                  </button>
                  <button type="button" disabled={sending === p.id} onClick={() => void decide(p, "dismiss")} className="press inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 text-callout text-fg-3 hover:text-fg">
                    <XIcon size={15} />
                    Dismiss
                  </button>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      ) : (
        <EmptyCard
          icon={<CheckIcon size={20} />}
          title={items.length ? "All proposals handled" : "No proposals yet"}
          body={items.length ? "Decisions are shared by every device, and the distill won't propose a dismissed one again." : "The weekly distill writes its skill and memory proposals here with the evidence behind each."}
        />
      )}
      {decided.length ? (
        <div className="mt-2">
          <button type="button" onClick={() => setShowDecided((v) => !v)} aria-expanded={showDecided} className="press min-h-9 px-1 text-caption text-fg-3 hover:text-fg">
            {showDecided ? "Hide" : "Show"} {decided.length} decided
          </button>
          {showDecided ? (
            <ul className="mt-1 overflow-hidden rounded-card border border-line bg-card">
              {decided.map((p) => {
                const s = STATUS[statusKey(statusOf(p))] || STATUS["sent to the chief"];
                return (
                  <li key={p.id} className="flex items-center gap-2 border-b border-line px-3 py-2 last:border-b-0">
                    <span className="min-w-0 flex-1 truncate text-callout text-fg-2">{p.target}</span>
                    <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-caption font-medium ${s.tone}`}>{s.label.replace("{name}", assistant)}</span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
