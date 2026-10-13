"use client";

import { AnimatePresence, motion } from "motion/react";

import { MailIcon, ShieldAlertIcon, TerminalIcon } from "@/components/icons";
import { HoldButton } from "@/components/ui/hold-button";
import { Sheet } from "@/components/ui/sheet";
import { revealCommand } from "@/lib/command-display";
import { useAssistantName } from "@/lib/identity";
import { mailAction, type MailAction } from "@/lib/mail-approval";
import { SPRING } from "@/lib/motion";
import type { ApprovalChoice, ExecApproval } from "@/lib/types";
import { LAYER } from "@/lib/layers";

/**
 * Approval arrives as a sheet over the thread (VISUAL-OVERHAUL §3.2, §5 #9). "Always allow" is
 * press-and-hold. Minimize keeps it one tap away as a pill above the composer.
 *
 * Nothing the bot writes may hide what runs: a mail action shows its email and then the exact call, and every command
 * is shown with hidden characters and padding made visible (lib/command-display.ts).
 */
export function ApprovalSheet({
  approval,
  minimized,
  resolving,
  error,
  onMinimize,
  onExpand,
  onChoose,
}: {
  approval: ExecApproval | null | undefined;
  minimized: boolean;
  resolving: boolean;
  error: string;
  onMinimize: () => void;
  onExpand: () => void;
  onChoose: (choice: ApprovalChoice) => void;
}) {
  const assistant = useAssistantName();
  // A mail action (mail_guard.py) shows who it goes to and what it says, not a command line.
  const mail = approval ? mailAction(approval) : null;
  // "Always allow" is offered only where it means something bounded (never for a mail call the guard couldn't read).
  const always = approval?.allowPermanent !== false && (!mail || mail.always !== null);
  return (
    <>
      <Sheet
        open={!!approval && !minimized}
        onClose={onMinimize}
        closeLabel="Minimize"
        scope="container"
        zIndex={LAYER.paneSheet}
        title={mail ? mail.title : "Command approval required"}
        subtitle={mail ? `${assistant} wants to ${mail.what.charAt(0).toLowerCase()}${mail.what.slice(1)}` : `${assistant} wants to run this on your PC`}
        className="approval-glow"
      >
        {approval ? (
          <div className="space-y-4 px-4 pb-5">
            {mail ? <MailPreview mail={mail} /> : null}
            {mail && !mail.exact ? null : <ExactCommand label={mail ? "Exact call" : "Command"} command={mail ? mail.exact : approval.command || "Pending command"} />}
            {approval.reason && !mail ? (
              <p className="flex items-start gap-2 text-callout text-warn">
                <ShieldAlertIcon size={16} className="mt-0.5 shrink-0" />
                <span>{approval.reason}</span>
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-callout text-danger">
                {error}
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="approve-once press" disabled={resolving} onClick={() => onChoose("once")}>
                Allow once
              </button>
              {approval.allowSession !== false ? (
                <button type="button" className="approve-session press" disabled={resolving} onClick={() => onChoose("session")}>
                  This session
                </button>
              ) : null}
              {always ? (
                <HoldButton
                  className="approve-always"
                  disabled={resolving}
                  ariaLabel="Always allow (press and hold)"
                  holdingLabel="Keep holding…"
                  onConfirm={() => onChoose("always")}
                >
                  Always allow
                </HoldButton>
              ) : null}
              <button type="button" className="approve-deny press" disabled={resolving} onClick={() => onChoose("deny")}>
                Deny
              </button>
            </div>
            {always ? (
              <p className="text-caption text-fg-3">
                {mail ? `Press and hold “Always allow” to let your bots ${mail.always} from now on.` : "Press and hold “Always allow” to trust this command pattern from now on."}
              </p>
            ) : mail ? (
              <p className="text-caption text-fg-3">This couldn’t be read exactly, so it can only be allowed one time at a time. Check the exact call above.</p>
            ) : null}
          </div>
        ) : null}
      </Sheet>
      <AnimatePresence>
        {approval && minimized ? (
          <motion.button
            key="approval-mini"
            type="button"
            onClick={onExpand}
            className="mx-3 mb-2 flex min-h-11 items-center gap-2 rounded-full border border-warn/40 bg-warn/10 px-4 text-callout font-medium text-warn"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0, transition: SPRING.bouncy }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.14 } }}
          >
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-warn opacity-70" />
              <span className="relative h-2.5 w-2.5 rounded-full bg-warn" />
            </span>
            Approval needed · Review
          </motion.button>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/** What will run, exactly: hidden characters shown as markers, padding collapsed, and a note when either was found. */
function ExactCommand({ label, command }: { label: string; command: string }) {
  const shown = revealCommand(command);
  return (
    <div className="rounded-card border border-warn/25 bg-canvas">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-caption text-fg-3">
        <TerminalIcon size={14} />
        <span className="min-w-0 flex-1">{label}</span>
        {command.length > 400 ? <span className="shrink-0 font-mono text-micro">{command.length} characters · scroll</span> : null}
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-code text-fg">{shown.text}</pre>
      {shown.hidden || shown.collapsed ? (
        <p className="flex items-start gap-2 border-t border-line px-3 py-2 text-caption text-warn">
          <ShieldAlertIcon size={14} className="mt-0.5 shrink-0" />
          {shown.hidden ? `${shown.hidden} hidden character${shown.hidden === 1 ? "" : "s"} shown as markers. ` : ""}
          {shown.collapsed ? "Long runs of blank space were shortened. " : ""}
          Check it carefully.
        </p>
      ) : null}
    </div>
  );
}

/** The email (or invitation, or share) as the owner would read it: who, what, and the start of the message. */
function MailPreview({ mail }: { mail: MailAction }) {
  return (
    <div className="rounded-card border border-warn/25 bg-canvas">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-caption text-fg-3">
        <MailIcon size={14} />
        {mail.what}
      </div>
      {mail.fields.length ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2.5 text-callout">
          {mail.fields.map((f) => (
            <div key={f.key} className="contents">
              <dt className="text-fg-3">{f.key}</dt>
              <dd className="min-w-0 break-words text-fg">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {mail.body ? <p className="max-h-40 overflow-auto border-t border-line px-3 py-2.5 text-callout whitespace-pre-wrap text-fg-2">{mail.body}</p> : null}
    </div>
  );
}
