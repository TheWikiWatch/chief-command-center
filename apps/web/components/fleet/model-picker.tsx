"use client";

import { useEffect, useId, useState } from "react";

import { CircleAlertIcon, CircleCheckIcon } from "@/components/icons";
import { fleetApi, type ModelsResult } from "@/lib/fleet-client";

/**
 * A bot's model (the chief's too): every model of a connected provider, grouped by provider. Changing it pins
 * the bot through Hermes; the provider's key goes with it. Expensive models ask first, as Hermes does.
 */
export function ModelPicker({ profile, provider, model, onChanged }: { profile: string; provider: string; model: string; onChanged?: () => void }) {
  const id = useId();
  const [options, setOptions] = useState<ModelsResult | null>(null);
  const [loadError, setLoadError] = useState("");
  const [current, setCurrent] = useState({ provider, model });
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error" | "confirm"; text: string; pending?: { provider: string; model: string } } | null>(null);

  useEffect(() => setCurrent({ provider, model }), [provider, model]);
  useEffect(() => {
    fleetApi
      .models()
      .then((r) => (r.ok ? setOptions(r) : setLoadError(r.error || "Couldn't list models.")))
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : "Couldn't list models."));
  }, []);

  async function choose(next: { provider: string; model: string }, confirm = false) {
    setSaving(true);
    setNote(null);
    try {
      const res = await fleetApi.setModel(profile, next.provider, next.model, confirm);
      if (res.confirm) {
        setNote({ tone: "confirm", text: res.confirm, pending: next });
        return;
      }
      if (!res.ok) {
        setNote({ tone: "error", text: res.error || "That model couldn't be set." });
        return;
      }
      setCurrent(next);
      setNote({ tone: "ok", text: "Saved. It answers with this model from the next message." });
      onChanged?.();
    } catch (e) {
      setNote({ tone: "error", text: e instanceof Error ? e.message : "That model couldn't be set." });
    } finally {
      setSaving(false);
    }
  }

  const value = `${current.provider}\u0001${current.model}`;
  const known = options?.groups.some((g) => g.provider === current.provider && g.models.includes(current.model));
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-callout text-fg-2">
        Model
      </label>
      <select
        id={id}
        value={value}
        disabled={!options || saving}
        onChange={(e) => {
          const [p, m] = e.target.value.split("\u0001");
          void choose({ provider: p, model: m });
        }}
        className="min-h-11 w-full rounded-ctl border border-line-2 bg-canvas px-3 text-body text-fg outline-none focus:border-line-3 disabled:opacity-60"
      >
        {!known ? <option value={value}>{current.model ? `${current.model} (${current.provider || "unknown"})` : "Not set"}</option> : null}
        {(options?.groups || []).map((g) => (
          <optgroup key={g.provider} label={g.name}>
            {g.models.map((m) => (
              <option key={`${g.provider}:${m}`} value={`${g.provider}\u0001${m}`}>
                {m}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {loadError ? <Line tone="error">{loadError}</Line> : null}
      {options && !options.groups.length ? <Line tone="error">No provider is connected. Add one in Settings, then Models &amp; keys.</Line> : null}
      {note?.tone === "confirm" && note.pending ? (
        <div className="space-y-2 rounded-card border border-warn/30 bg-warn/[0.06] px-3 py-2">
          <Line tone="warn">{note.text}</Line>
          <div className="flex gap-2">
            <button type="button" disabled={saving} onClick={() => void choose(note.pending!, true)} className="press min-h-10 rounded-full bg-fg px-4 text-callout font-semibold text-canvas disabled:opacity-50">
              Use it anyway
            </button>
            <button type="button" onClick={() => setNote(null)} className="press min-h-10 rounded-full border border-line-2 px-4 text-callout text-fg-2 hover:text-fg">
              Cancel
            </button>
          </div>
        </div>
      ) : note ? (
        <Line tone={note.tone === "ok" ? "ok" : "error"}>{note.text}</Line>
      ) : null}
    </div>
  );
}

function Line({ tone, children }: { tone: "ok" | "error" | "warn"; children: React.ReactNode }) {
  const Icon = tone === "ok" ? CircleCheckIcon : CircleAlertIcon;
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-2 text-callout ${tone === "error" ? "text-danger" : "text-fg-2"}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : ""}`} />
      <span>{children}</span>
    </p>
  );
}
