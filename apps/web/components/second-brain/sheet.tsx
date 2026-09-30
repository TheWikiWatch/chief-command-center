"use client";

import { useState } from "react";

import { Sheet } from "@/components/ui/sheet";
import { SecondBrainSetup } from "@/components/second-brain/setup";

/** The Second Brain setup on its own, opened from Today or Vault before a folder is chosen. */
export function SecondBrainSheet({
  open,
  phone,
  onClose,
  onAskChief,
}: {
  open: boolean;
  phone: boolean;
  onClose: () => void;
  onAskChief?: (text: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} onClose={onClose} title="Second Brain" side={phone ? "bottom" : "right"} tall closeDisabled={busy}>
      <div className="px-4 pb-10 pt-1">
        <SecondBrainSetup onBusy={setBusy} onAskChief={onAskChief} />
      </div>
    </Sheet>
  );
}
