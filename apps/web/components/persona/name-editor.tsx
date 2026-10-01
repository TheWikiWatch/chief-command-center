"use client";

import { useEffect, useId, useRef, useState } from "react";

import { CircleAlertIcon } from "@/components/icons";
import { renameProfile } from "@/lib/bridge";

/**
 * A bot's name and role (the chief's too). Saving rewrites the profile's title, and unless unticked the
 * SOUL's opening "You are <old name>" follows. `onSaved` gets the new title ("Name - Role").
 */
export function NameEditor({
  profile,
  name,
  role,
  onSaved,
  onCancel,
}: {
  profile: string;
  name: string;
  role: string;
  onSaved: (result: { title: string; name: string; role: string; soul: string }) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [draftName, setDraftName] = useState(name);
  const [draftRole, setDraftRole] = useState(role);
  const [soul, setSoul] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const changed = draftName.trim() !== name || draftRole.trim() !== role;
  async function save() {
    if (!draftName.trim() || !changed) return;
    setBusy(true);
    setError("");
    try {
      const res = await renameProfile(profile, draftName.trim(), draftRole.trim(), soul);
      if (!res.ok) throw new Error(res.error || "The name wasn't saved.");
      onSaved({ title: res.title || draftName.trim(), name: res.name || draftName.trim(), role: res.role ?? draftRole.trim(), soul: res.soul || "" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The name wasn't saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="w-full max-w-sm space-y-2.5 text-left"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onCancel();
      }}
    >
      <label htmlFor={`${id}-name`} className="block text-caption text-fg-3">
        Name
        <input
          id={`${id}-name`}
          ref={first}
          value={draftName}
          maxLength={40}
          onChange={(e) => setDraftName(e.target.value)}
          className="mt-1 min-h-11 w-full rounded-ctl border border-line-2 bg-canvas px-3 text-body text-fg outline-none focus:border-line-3"
        />
      </label>
      <label htmlFor={`${id}-role`} className="block text-caption text-fg-3">
        Role
        <input
          id={`${id}-role`}
          value={draftRole}
          maxLength={60}
          placeholder="e.g. Chief of Staff"
          onChange={(e) => setDraftRole(e.target.value)}
          className="mt-1 min-h-11 w-full rounded-ctl border border-line-2 bg-canvas px-3 text-body text-fg outline-none placeholder:text-fg-3 focus:border-line-3"
        />
      </label>
      <label className="flex items-start gap-2.5 py-1 text-callout text-fg-2">
        <input type="checkbox" checked={soul} onChange={(e) => setSoul(e.target.checked)} className="mt-0.5 size-4 accent-[color:var(--accent)]" />
        <span>Also update the SOUL&apos;s &ldquo;You are {name}&rdquo; to the new name</span>
      </label>
      {error ? (
        <p role="alert" className="flex items-start gap-2 text-callout text-danger">
          <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
      <div className="flex gap-2 pt-1">
        <button type="submit" disabled={busy || !draftName.trim() || !changed} className="press min-h-10 rounded-full bg-fg px-4 text-callout font-semibold text-canvas disabled:opacity-50">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="press min-h-10 rounded-full border border-line-2 px-4 text-callout text-fg-2 hover:text-fg">
          Cancel
        </button>
      </div>
    </form>
  );
}
