"use client";

import { useCallback, useEffect, useState } from "react";

import { CircleAlertIcon, CircleCheckIcon } from "@/components/icons";
import { ConnectModel } from "@/components/onboarding/connect-model";
import { useAssistantName } from "@/lib/identity";
import { setup, type ProviderRow } from "@/lib/setup-client";
import { btn } from "@/components/ui/button";
import { ConfirmRow } from "@/components/ui/confirm-row";
import { MODELS_CHANGED_EVENT, modelsChanged } from "@/lib/app-events";
import { friendlyError } from "@/lib/request";

/**
 * Settings → Models & keys: the providers this install can use (keys and local endpoints), which one the chief
 * is on, and adding, replacing or removing a key. Every connected provider's models show in each bot's model
 * list. Keys go up once and never come back to the screen.
 */
export function ModelsKeys() {
  const assistant = useAssistantName();
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback((refresh = false) => {
    setError("");
    setup
      .providers(refresh)
      .then((c) => (c.ok ? setRows(c.providers.filter((p) => p.connected && p.kind !== "external")) : setError(c.error || "Couldn't read providers.")))
      .catch((e: unknown) => setError(friendlyError(e, "Couldn't read providers.")));
  }, []);
  useEffect(() => load(), [load]);
  useEffect(() => {
    const again = () => load();
    window.addEventListener(MODELS_CHANGED_EVENT, again);
    return () => window.removeEventListener(MODELS_CHANGED_EVENT, again);
  }, [load]);

  async function remove(p: ProviderRow) {
    setBusy(p.slug);
    setNote(null);
    try {
      const res = await setup.removeKey(p.slug);
      setNote(res.ok ? { tone: "ok", text: `${p.name}'s key was removed.` } : { tone: "error", text: res.error || "The key wasn't removed." });
      load(true);
      if (res.ok) modelsChanged();
    } catch (e) {
      setNote({ tone: "error", text: friendlyError(e, "The key wasn't removed.") });
    } finally {
      setBusy("");
      setConfirm("");
    }
  }

  return (
    <div>
      {rows === null && !error ? <p className="px-3.5 py-3 text-callout text-fg-3">Reading…</p> : null}
      {error ? <Line tone="error">{error}</Line> : null}
      {rows && !rows.length ? <p className="px-3.5 py-3 text-callout text-fg-3">No provider is connected yet.</p> : null}
      {rows?.map((p) => (
        <div key={p.slug} className="border-b border-(--line-1) px-3.5 py-3 last:border-b-0">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-body text-fg">{p.name}</p>
              <p className="text-caption text-fg-3">
                {p.kind === "custom" ? "A model server you added" : p.keySaved ? "Key saved on this PC" : "Signed in on this PC"}
                {p.models.length ? ` · ${p.models.length} model${p.models.length === 1 ? "" : "s"}` : ""}
              </p>
            </div>
            {p.current ? <span className="shrink-0 rounded-full bg-ok/15 px-2 py-0.5 text-caption text-ok">In use by {assistant}</span> : null}
            {p.kind === "key" && p.keySaved && !p.current ? (
              <button
                type="button"
                disabled={!!busy}
                onClick={() => setConfirm(confirm === p.slug ? "" : p.slug)}
                className="press min-h-9 shrink-0 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg disabled:opacity-50"
              >
                Remove…
              </button>
            ) : null}
          </div>
          {confirm === p.slug ? (
            <ConfirmRow className="mt-2" confirm="Remove key" busy={busy === p.slug} busyLabel="Removing…" onConfirm={() => void remove(p)} onCancel={() => setConfirm("")}>
              Remove the {p.name} key from this PC? Bots set to a {p.name} model stop working until you pick another model or add a key again.
            </ConfirmRow>
          ) : null}
        </div>
      ))}
      {note ? <Line tone={note.tone}>{note.text}</Line> : null}
      <div className="border-t border-(--line-1) px-3.5 py-3">
        {adding ? (
          <div className="space-y-3">
            <ConnectModel addOnly onAdded={() => load(true)} />
            <button type="button" onClick={() => setAdding(false)} className="press min-h-10 rounded-full border border-line-2 px-4 text-callout text-fg-2 hover:text-fg">
              Done
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className={btn("primary", "md")}>
            Add or replace a key
          </button>
        )}
      </div>
    </div>
  );
}

function Line({ tone, children }: { tone: "ok" | "error"; children: React.ReactNode }) {
  const Icon = tone === "ok" ? CircleCheckIcon : CircleAlertIcon;
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-2 px-3.5 py-2.5 text-callout ${tone === "error" ? "text-danger" : "text-fg-2"}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone === "ok" ? "text-ok" : ""}`} />
      <span>{children}</span>
    </p>
  );
}
