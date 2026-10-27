"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";

/**
 * "Remove this? [Remove] [Keep]": the one way Settings asks before something can't be undone (a key, a paired
 * phone, an account, phone access, a downloaded model). The question says what goes and what it affects.
 */
export function ConfirmRow({
  children,
  confirm,
  busy = false,
  busyLabel,
  keep = "Keep",
  onConfirm,
  onCancel,
  className = "",
}: {
  children: ReactNode;
  confirm: string;
  busy?: boolean;
  busyLabel?: string;
  keep?: string;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label={confirm} className={`flex flex-wrap items-center gap-2 rounded-ctl bg-fill-1 px-3 py-2.5 ${className}`}>
      <p className="min-w-0 flex-1 basis-48 text-callout text-fg-2">{children}</p>
      <Button variant="danger" size="sm" disabled={busy} onClick={onConfirm}>
        {busy ? busyLabel || `${confirm}…` : confirm}
      </Button>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
        {keep}
      </Button>
    </div>
  );
}
