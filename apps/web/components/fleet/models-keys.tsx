"use client";

import { useCallback, useEffect, useState } from "react";

import { CircleAlertIcon, CircleCheckIcon } from "@/components/icons";
import { ConnectModel } from "@/components/onboarding/connect-model";
import { useAssistantName } from "@/lib/identity";
import { setup, type ProviderRow } from "@/lib/setup-client";

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
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't read providers."));
  }, []);
  useEffect(() => load(), [load]);

  async function remove(p: ProviderRow) {
    setBusy(p.slug);
    setNote(null);
    try {
      const res = await setup.removeKey(p.slug);
      setNote(res.ok ? { tone: "ok", text: `${p.name}'s key was removed.` } : { tone: "error", text: res.error || "The key wasn't removed." });
      load(true);
    } catch (e) {
      setNote({ tone: "error", text: e instanceof Error ? e.message : "The key wasn't removed." });
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
        <div key={p.slug} className="border-b border-[color:var(--line-1)] px-3.5 py-3 last:border-b-0">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-body text-fg">{p.name}</p>
              <p className="text-caption text-fg-3">
                {p.kind === "custom" ? "Local or custom endpoint" : p.keySaved ? "API key saved" : "Signed in on this PC"}
                {p.models.length ? ` · ${p.models.length} model${p.models.length === 1 ? "" : "s"}` : ""}
              </p>
            </div>
            {p.current ? <span className="shrink-0 rounded-full bg-ok/15 px-2 py-0.5 text-caption text-ok">{assistant} uses this</span> : null}
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
            <div className="mt-2 space-y-2 rounded-card border border-danger/30 bg-danger/[0.06] px-3 py-2">
              <p className="text-callout text-fg">Remove the {p.name} key from this PC? Bots set to a {p.name} model stop working until you pick another model or add a key again.</p>
              <div className="flex gap-2">
                <button type="button" disabled={!!busy} onClick={() => void remove(p)} className="press min-h-10 rounded-full bg-danger px-3.5 text-callout font-medium text-white disabled:opacity-50">
                  {busy === p.slug ? "Removing…" : "Remove key"}
                </button>
                <button type="button" onClick={() => setConfirm("")} className="press min-h-10 rounded-full border border-line-2 px-3.5 text-callout text-fg-2 hover:text-fg">
                  Keep it
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
      {note ? <Line tone={note.tone}>{note.text}</Line> : null}
      <div className="border-t border-[color:var(--line-1)] px-3.5 py-3">
        {adding ? (
          <div className="space-y-3">
            <ConnectModel addOnly onAdded={() => load(true)} />
            <button type="button" onClick={() => setAdding(false)} className="press min-h-10 rounded-full border border-line-2 px-4 text-callout text-fg-2 hover:text-fg">
              Done
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="press min-h-10 rounded-full bg-fg px-4 text-callout font-semibold text-canvas">
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
