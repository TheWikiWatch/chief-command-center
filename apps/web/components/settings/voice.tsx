"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLinesIcon, CheckIcon, PlayIcon, RefreshCwIcon, SquareIcon } from "@/components/icons";
import { Group } from "@/components/ui/settings-group";
import { fetchSettings, patchSettings, speakText, type HermesSettings, type SettingsProvider, type VoiceChoice } from "@/lib/bridge";
import { notifyVoiceConfig } from "@/lib/dashboard-prefs";
import { stopSpeech } from "@/lib/voice-client";
import { useAssistantName, ownerName } from "@/lib/identity";
import { CheckMySystem } from "@/components/voice/check-my-system";
import { loadVoiceCheck, type VoiceCheckResult } from "@/lib/mic-device";
import { field } from "@/components/ui/field";
import { btn } from "@/components/ui/button";
import { ApplyBody, previewLine } from "@/components/settings-panel";
import { Field, Select } from "@/components/settings/shared";

/* Settings → Voice: hearing and speaking engines, keys, the voice preview and Check my system. */

export function describeCheck(r: VoiceCheckResult | null): string {
  if (!r) return "Not run on this device yet.";
  const parts = [
    r.mic === "ok" ? "microphone works" : r.mic === "skipped" ? "" : "microphone needs attention",
    r.speaker === "heard" ? "speakers work" : r.speaker === "skipped" ? "" : "speakers need attention",
    r.typing === "ok" ? "voice typing works" : r.typing === "not-set-up" ? "voice typing not set up" : r.typing === "skipped" ? "" : "voice typing needs attention",
  ].filter(Boolean);
  const when = new Date(r.at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return parts.length ? `${when}: ${parts.join(", ")}.` : `${when}: skipped.`;
}

export function SystemCheckRow() {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<VoiceCheckResult | null>(null);
  useEffect(() => setLast(loadVoiceCheck()), [open]);
  return (
    <div className="rounded-ctl bg-fill-1 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-body text-fg">Check my system</p>
          <p className="mt-0.5 text-caption text-fg-3">{describeCheck(last)}</p>
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)} className="press min-h-9 shrink-0 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg">
          {open ? "Close" : "Run"}
        </button>
      </div>
      {open ? (
        <div className="mt-3">
          <CheckMySystem onResult={setLast} />
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Second Brain */

export function VoiceGroup() {
  const assistant = useAssistantName();
  const [data, setData] = useState<HermesSettings | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchSettings();
      setData(next);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Could not load Hermes settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply(body: ApplyBody) {
    setSaving(true);
    setError("");
    try {
      const next = await patchSettings(body);
      setData(next);
      notifyVoiceConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      throw err;
    } finally {
      setSaving(false);
    }
  }

  const stt = data?.stt;
  const tts = data?.tts;
  const pickerReady = (stt?.providers?.length || 0) > 0 || (tts?.providers?.length || 0) > 0;
  const voiceLabel = tts?.voice_label || (tts?.provider === "elevenlabs" ? "ElevenLabs voice" : tts?.provider === "edge" ? "Edge voice" : "");
  const voicePickable = !!voiceLabel;

  return (
    <Group
      icon={<AudioLinesIcon className="size-4" />}
      title={`${assistant}’s voice`}
      hint={`Add a key here if an engine needs one. It is saved to ${assistant}’s own profile on this PC.`}
      action={
        <button
          type="button"
          aria-label="Refresh"
          title="Refresh from Hermes"
          className="press grid size-9 place-items-center rounded-full text-fg-3 hover:bg-fill-2 hover:text-fg disabled:opacity-40"
          disabled={loading || saving}
          onClick={() => void load()}
        >
          <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      }
    >
      <div className="space-y-4 p-3">
        <SystemCheckRow />
        {loading && !data ? (
          <div className="space-y-2" role="status" aria-label="Loading Hermes…">
            <div className="h-11 rounded-ctl bg-fill-1" />
            <div className="h-11 rounded-ctl bg-fill-1" />
            <div className="h-11 rounded-ctl bg-fill-1" />
          </div>
        ) : null}
        {!loading && !pickerReady ? (
          <p className="rounded-ctl bg-fill-1 px-3 py-2 text-callout text-fg-2">
            Voice picker needs a relaunch of Chief Command Center. Current: {stt?.provider || "local"} /{" "}
            {tts?.provider || "edge"}.
          </p>
        ) : null}
        {pickerReady ? (
          <>
            <ProviderList
              label="Hearing"
              providers={stt?.providers || []}
              current={stt?.provider || "local"}
              saving={saving}
              onSelect={(id) => void apply({ stt: { provider: id } }).catch(() => undefined)}
              onSaveKey={(envKey, apiKey) => apply({ secrets: { [envKey]: apiKey } })}
            />
            {(stt?.models?.length || 0) > 0 ? (
              <Field label="Hearing model">
                <Select
                  value={stt?.model && stt.models?.includes(stt.model) ? stt.model : stt?.models?.[0] || ""}
                  disabled={saving}
                  onChange={(id) => void apply({ stt: { model: id } }).catch(() => undefined)}
                >
                  {(stt?.models || []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <ProviderList
              label="Speaking"
              providers={tts?.providers || []}
              current={tts?.provider || "edge"}
              saving={saving}
              onSelect={(id) => void apply({ tts: { provider: id } }).catch(() => undefined)}
              onSaveKey={(envKey, apiKey) => apply({ secrets: { [envKey]: apiKey } })}
            />
            {voicePickable && (tts?.voices?.length || 0) > 0 ? (
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label={voiceLabel}>
                    <Select
                      value={
                        tts?.voice && tts.voices?.some((v) => v.id === tts.voice) ? tts.voice : tts?.voices?.[0]?.id || ""
                      }
                      disabled={saving}
                      onChange={(id) => void apply({ tts: { voice: id } }).catch(() => undefined)}
                    >
                      <VoiceOptions voices={tts?.voices || []} />
                    </Select>
                  </Field>
                </div>
                <VoicePreview disabled={saving} />
              </div>
            ) : null}
            {!voicePickable ? (
              <p className="text-caption text-fg-3">
                Voice for this engine: <span className="text-fg-2">{tts?.voice || "set in Hermes"}</span>.
              </p>
            ) : null}
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-callout text-danger">
            {error}
          </p>
        ) : null}
        <p className="text-caption text-fg-3">Linked to Hermes chief profile</p>
      </div>
    </Group>
  );
}

/* ------------------------------------------------------------------ This app */

export function ProviderList({
  label,
  providers,
  current,
  saving,
  onSelect,
  onSaveKey,
}: {
  label: string;
  providers: SettingsProvider[];
  current: string;
  saving: boolean;
  onSelect: (id: string) => void;
  onSaveKey: (envKey: string, apiKey: string) => Promise<void>;
}) {
  // A key box opens only when the owner picks a provider that needs one.
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div>
      <p className="mb-1.5 px-1 text-caption font-medium text-fg-3">{label}</p>
      <div role="radiogroup" aria-label={label} className="overflow-hidden rounded-ctl border border-line bg-well">
        {providers.map((p, i) => {
          const selected = p.id === current;
          const ready = p.status === "ready" || selected;
          const needsKey = p.status === "needs_keys";
          const open = openId === p.id && needsKey;
          return (
            <div key={p.id} className={i ? "border-t border-line" : ""}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={saving || (!ready && !needsKey)}
                onClick={() => {
                  if (needsKey) {
                    setOpenId(open ? null : p.id);
                    return;
                  }
                  if (!selected) onSelect(p.id);
                }}
                className={`flex min-h-12 w-full items-center gap-3 px-3 text-left transition-colors duration-fast disabled:opacity-45 ${
                  selected ? "bg-fill-2" : "hover:bg-fill-1"
                }`}
              >
                <span
                  aria-hidden
                  className={`grid size-5 shrink-0 place-items-center rounded-full border transition-colors duration-fast ${
                    selected ? "border-transparent bg-fg text-canvas" : "border-line-3"
                  }`}
                >
                  {selected ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
                </span>
                <span className={`min-w-0 flex-1 truncate text-body ${selected ? "font-medium text-fg" : "text-fg-2"}`}>
                  {p.name}
                </span>
                <StatusChip provider={p} selected={selected} />
              </button>
              {open ? (
                <KeyField
                  provider={p}
                  saving={saving}
                  onSave={async (envKey, apiKey) => {
                    await onSaveKey(envKey, apiKey);
                    setOpenId(null);
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function StatusChip({ provider, selected }: { provider: SettingsProvider; selected: boolean }) {
  if (selected) return <span className="shrink-0 text-caption font-medium text-fg-2">current</span>;
  if (provider.status === "ready") return <span className="shrink-0 text-caption text-fg-3">ready</span>;
  if (provider.status === "needs_keys") {
    return <span className="shrink-0 rounded-chip bg-warn/15 px-1.5 py-0.5 text-caption text-warn">needs key</span>;
  }
  return (
    <span className="max-w-[45%] shrink-0 truncate text-caption text-fg-3">
      {provider.hint || provider.status.replaceAll("_", " ")}
    </span>
  );
}

export function KeyField({
  provider,
  saving,
  onSave,
}: {
  provider: SettingsProvider;
  saving: boolean;
  onSave: (envKey: string, apiKey: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [localError, setLocalError] = useState("");
  const envKey = provider.env_key || (provider.id === "elevenlabs" ? "ELEVENLABS_API_KEY" : "");

  async function submit() {
    if (!envKey || !value.trim()) return;
    setLocalError("");
    try {
      await onSave(envKey, value.trim());
      setValue("");
      setReveal(false);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Could not save");
    }
  }

  return (
    <div className="space-y-2 border-t border-line bg-black/20 px-3 py-3">
      <p className="text-caption text-fg-3">{provider.hint || "Add this key to the chief’s profile"}</p>
      <div className="flex gap-2">
        <input
          type={reveal ? "text" : "password"}
          value={value}
          autoComplete="off"
          spellCheck={false}
          disabled={saving || !envKey}
          placeholder="API key"
          aria-label={`${provider.name} API key`}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          className={field({ mono: true, extra: "min-w-0 flex-1" })}
        />
        <button type="button" className="chat-type-btn min-h-11 px-3" disabled={saving} onClick={() => setReveal((v) => !v)}>
          {reveal ? "Hide" : "Show"}
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {provider.key_url ? (
          <a
            href={provider.key_url}
            target="_blank"
            rel="noreferrer"
            className="text-caption text-fg-3 underline-offset-2 hover:text-fg hover:underline"
          >
            Get a key
          </a>
        ) : (
          <span />
        )}
        <button
          type="button"
          className={btn("primary", "md")}
          disabled={saving || !envKey || !value.trim()}
          onClick={() => void submit()}
        >
          Save to Hermes (chief)
        </button>
      </div>
      {localError ? <p className="text-caption text-danger">{localError}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Primitives */

/** Voice options, grouped when the engine groups them (VoiceStudio: designed vs your saved voices). */
export function VoiceOptions({ voices }: { voices: VoiceChoice[] }) {
  const groups: [string, VoiceChoice[]][] = [];
  for (const v of voices) {
    const key = v.group || "";
    const hit = groups.find(([g]) => g === key);
    if (hit) hit[1].push(v);
    else groups.push([key, [v]]);
  }
  const option = (v: VoiceChoice) => (
    <option key={v.id} value={v.id}>
      {v.label}
    </option>
  );
  if (groups.length <= 1) return <>{voices.map(option)}</>;
  return (
    <>
      {groups.map(([g, list]) =>
        g ? (
          <optgroup key={g} label={g}>
            {list.map(option)}
          </optgroup>
        ) : (
          list.map(option)
        ),
      )}
    </>
  );
}

/** Hear the saved voice: one short line through the chief's real speaking engine. */
export function VoicePreview({ disabled }: { disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const play = async () => {
    if (state !== "idle") {
      audio.current?.pause();
      setState("idle");
      return;
    }
    setState("loading");
    try {
      const res = await speakText(previewLine(ownerName()), 30_000);
      const src = res.data_urls?.[0] || res.data_url;
      if (!res.ok || !src) throw new Error(res.error || "No audio");
      stopSpeech();
      const el = new Audio(src);
      audio.current = el;
      el.onended = () => setState("idle");
      el.onerror = () => setState("idle");
      await el.play();
      setState("playing");
    } catch {
      setState("idle");
    }
  };
  return (
    <button
      type="button"
      aria-label={state === "idle" ? "Preview voice" : "Stop preview"}
      title={state === "idle" ? "Preview voice" : "Stop preview"}
      className="press grid size-11 shrink-0 place-items-center rounded-ctl border border-line bg-well text-fg-2 hover:text-fg disabled:opacity-40"
      disabled={disabled}
      onClick={() => void play()}
    >
      {state === "loading" ? (
        <RefreshCwIcon className="size-4 animate-spin" />
      ) : state === "playing" ? (
        <SquareIcon className="size-3.5" />
      ) : (
        <PlayIcon className="size-4" />
      )}
    </button>
  );
}
