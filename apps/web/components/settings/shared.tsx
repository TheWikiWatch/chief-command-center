"use client";

import { type ReactNode } from "react";
import { Switch } from "@/components/ui/controls";

/* Rows and controls shared by the Settings groups. */

export function SwitchRow({
  label,
  ariaLabel,
  hint,
  checked,
  disabled,
  dim,
  inset,
  extra,
  onChange,
}: {
  label: string;
  ariaLabel?: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  dim?: boolean;
  inset?: boolean;
  extra?: ReactNode;
  onChange: (next: boolean) => void;
}) {
  return (
    <div
      className={`flex min-h-12 items-center gap-2 px-3.5 py-2 transition-opacity duration-fast ${dim ? "opacity-45" : ""} ${
        inset ? "pl-5" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className={inset ? "text-callout text-fg-2" : "text-body text-fg"}>{label}</p>
        {hint ? <p className="mt-0.5 text-caption text-fg-3">{hint}</p> : null}
      </div>
      {extra}
      <Switch label={ariaLabel || label} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );
}

export { Switch };

/** What Settings → Voice sends to save a voice setup. */
export type ApplyBody = {
  stt?: { provider?: string; model?: string; api_key?: string };
  tts?: { provider?: string; voice?: string; api_key?: string };
  secrets?: Record<string, string>;
};

/** How the Second Brain folder is laid out, in words. */
export const BRAIN_MODE_LABEL: Record<string, string> = { new: "The Second Brain layout", keep: "Your own folders", reorganize: "Being reorganized" };

/** One short line, addressed to the owner when their name is known. */
export const previewLine = (owner: string) => (owner ? `Hi ${owner}. This is how I'll sound.` : "Hi. This is how I'll sound.");
