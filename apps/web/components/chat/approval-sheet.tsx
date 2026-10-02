"use client";

import { AnimatePresence, motion } from "motion/react";

import { ShieldAlertIcon, TerminalIcon } from "@/components/icons";
import { HoldButton } from "@/components/ui/hold-button";
import { Sheet } from "@/components/ui/sheet";
import { useAssistantName } from "@/lib/identity";
import { SPRING } from "@/lib/motion";
import type { ApprovalChoice, ExecApproval } from "@/lib/types";
import { LAYER } from "@/lib/layers";

/**
 * Approval arrives as a sheet over the thread (VISUAL-OVERHAUL §3.2, §5 #9). "Always allow" is
 * press-and-hold. Minimize keeps it one tap away as a pill above the composer.
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
  return (
    <>
      <Sheet
        open={!!approval && !minimized}
        onClose={onMinimize}
        closeLabel="Minimize"
        scope="container"
        zIndex={LAYER.paneSheet}
        title="Command approval required"
        subtitle={`${assistant} wants to run this on your PC`}
        className="approval-glow"
      >
        {approval ? (
          <div className="space-y-4 px-4 pb-5">
            <div className="rounded-card border border-warn/25 bg-canvas">
              <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-caption text-fg-3">
                <TerminalIcon size={14} />
                Command
              </div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-code text-fg">
                {approval.command || "Pending command"}
              </pre>
            </div>
            {approval.reason ? (
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
              {approval.allowPermanent !== false ? (
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
            {approval.allowPermanent !== false ? (
              <p className="text-caption text-fg-3">Press and hold “Always allow” to trust this command pattern from now on.</p>
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
