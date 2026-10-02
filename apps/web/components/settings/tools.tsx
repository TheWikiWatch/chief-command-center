"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, ImageIcon, RefreshCwIcon, SearchIcon, SparklesIcon } from "@/components/icons";
import { Group } from "@/components/ui/settings-group";
import { Button, btn } from "@/components/ui/button";
import { field } from "@/components/ui/field";
import { MessageMedia } from "@/components/message-media";
import { Field, Select } from "@/components/settings/shared";
import { fetchTools, patchTools, testTool, type ToolName, type ToolService, type ToolsState, type ToolTestResult } from "@/lib/bridge";
import { useAssistantName } from "@/lib/identity";

/*
 * Settings → Tools: the service the chief uses to make images and to search the web. The rows, readiness and
 * config writes are Hermes's own (`hermes tools`), read through the bridge (tools_settings.py); a key is saved to
 * the chief's profile, and "Try it" runs the real tool once.
 */

type Apply = (body: { provider?: string; model?: string; keys?: Record<string, string> }) => Promise<void>;

export function ToolsPage() {
  const [data, setData] = useState<ToolsState | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<ToolName | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await fetchTools());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read the tools from Hermes");
    } finally {
      setLoading(false);
    }
  }, []);

  // The first read: `loading` already starts true, so only the answer sets state.
  useEffect(() => {
    let live = true;
    fetchTools()
      .then((next) => live && setData(next))
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't read the tools from Hermes"))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const apply = (tool: ToolName): Apply => async (body) => {
    setSaving(tool);
    try {
      setData(await patchTools({ tool, ...body }));
    } finally {
      setSaving(null);
    }
  };

  const refresh = (
    <button
      type="button"
      aria-label="Refresh"
      title="Refresh from Hermes"
      className="press grid size-9 place-items-center rounded-full text-fg-3 hover:bg-fill-2 hover:text-fg disabled:opacity-40"
      disabled={loading || !!saving}
      onClick={() => void load()}
    >
      <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
    </button>
  );

  if (!data) {
    return (
      <div className="space-y-3">
        {loading ? (
          <div className="space-y-2" role="status" aria-label="Loading tools…">
            <div className="h-12 rounded-ctl bg-fill-1" />
            <div className="h-12 rounded-ctl bg-fill-1" />
            <div className="h-12 rounded-ctl bg-fill-1" />
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-ctl bg-fill-1 px-3 py-2.5">
            <p role="alert" className="min-w-0 flex-1 text-callout text-fg-2">
              {error || "Couldn't read the tools from Hermes."}
            </p>
            {refresh}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <ImageTool data={data.image} saving={saving === "image"} disabled={!!saving} apply={apply("image")} action={refresh} />
      <WebTool data={data.web} saving={saving === "web"} disabled={!!saving} apply={apply("web")} />
    </>
  );
}

function ImageTool({ data, saving, disabled, apply, action }: { data: ToolsState["image"]; saving: boolean; disabled: boolean; apply: Apply; action: ReactNode }) {
  const chief = useAssistantName();
  const active = data.providers.find((p) => p.active);
  const model = data.model?.options.find((m) => m.id === data.model?.current);
  return (
    <Group
      icon={<ImageIcon className="size-4" />}
      title="Making images"
      hint={`The service ${chief} uses when you ask for a picture. Keys are saved to ${chief}’s own profile on this PC.`}
      action={action}
    >
      <div className="space-y-4 p-3">
        <Summary ok={!!active}>
          {active ? (
            <>
              {chief} makes images with <span className="font-medium text-fg">{active.label}</span>
              {model ? <span className="text-fg-3"> · {model.label}</span> : null}.
            </>
          ) : (
            <>{chief} can’t make images yet. Pick a service below and add its key.</>
          )}
        </Summary>
        <ServiceList label="Image services" services={data.providers} saving={saving} disabled={disabled} apply={apply} />
        {data.model && data.model.options.length > 1 ? (
          <Field label="Model">
            <Select value={data.model.current} disabled={disabled} onChange={(id) => void apply({ model: id }).catch(() => undefined)}>
              {data.model.options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.detail ? `${m.label} · ${m.detail}` : m.label}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <TryIt tool="image" enabled={!!active && !disabled} label="Make a test image" busy="Making an image… this can take a minute." note="Uses your service once, so it may cost a few cents." />
      </div>
    </Group>
  );
}

function WebTool({ data, saving, disabled, apply }: { data: ToolsState["web"]; saving: boolean; disabled: boolean; apply: Apply }) {
  const chief = useAssistantName();
  const active = data.providers.find((p) => p.active);
  const auto = data.backends.search ? data.backends.search.charAt(0).toUpperCase() + data.backends.search.slice(1) : "";
  return (
    <Group icon={<SearchIcon className="size-4" />} title="Searching the web" hint={`The service ${chief} uses to look things up and read web pages.`}>
      <div className="space-y-4 p-3">
        <Summary ok={!!active || !!auto}>
          {active ? (
            <>
              {chief} searches with <span className="font-medium text-fg">{active.label}</span>.
            </>
          ) : auto ? (
            <>
              {chief} picks a search service on its own (now <span className="font-medium text-fg">{auto}</span>). Choose one below to decide for yourself; the free ones need no key.
            </>
          ) : (
            <>{chief} has no search service yet. The free ones below need no key.</>
          )}
        </Summary>
        <ServiceList label="Search services" services={data.providers} saving={saving} disabled={disabled} apply={apply} />
        <TryIt tool="web" enabled={!disabled && (!!active || !!auto)} label="Try a search" busy="Searching…" note="Searches for today’s top science news." />
      </div>
    </Group>
  );
}

function Summary({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-ctl bg-fill-1 px-3 py-2.5">
      <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${ok ? "bg-ok shadow-[0_0_6px_rgb(var(--c-ok)/0.55)]" : "bg-warn"}`} />
      <p className="min-w-0 flex-1 text-callout text-fg-2">{children}</p>
    </div>
  );
}

/** The services, recommended ones first; the rest open under "More services". */
function ServiceList({ label, services, saving, disabled, apply }: { label: string; services: ToolService[]; saving: boolean; disabled: boolean; apply: Apply }) {
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const main = services.filter((s) => s.active || s.recommended);
  const rest = services.filter((s) => !s.active && !s.recommended);
  const shown = more ? [...main, ...rest] : main;

  async function pick(service: ToolService, keys?: Record<string, string>) {
    setError("");
    try {
      await apply({ provider: service.name, ...(keys ? { keys } : {}) });
      setOpen(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      throw err;
    }
  }

  return (
    <div>
      <p className="mb-1.5 px-1 text-caption font-medium text-fg-3">{label}</p>
      <div role="radiogroup" aria-label={label} className="overflow-hidden rounded-ctl border border-line bg-well">
        {shown.map((s, i) => {
          const needsKey = s.status === "needs_keys";
          const usable = s.status === "ready" || needsKey || s.active;
          const expanded = open === s.name && needsKey;
          return (
            <div key={s.name} className={i ? "border-t border-line" : ""}>
              <button
                type="button"
                role="radio"
                aria-checked={s.active}
                disabled={disabled || !usable}
                onClick={() => {
                  if (needsKey) return setOpen(expanded ? null : s.name);
                  if (!s.active) void pick(s).catch(() => undefined);
                }}
                className={`flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left transition-colors duration-fast disabled:opacity-45 ${s.active ? "bg-fill-2" : "hover:bg-fill-1"}`}
              >
                <span
                  aria-hidden
                  className={`grid size-5 shrink-0 place-items-center rounded-full border transition-colors duration-fast ${s.active ? "border-transparent bg-fg text-canvas" : "border-line-3"}`}
                >
                  {s.active ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className={`max-w-full shrink-0 truncate text-body ${s.active ? "font-medium text-fg" : "text-fg-2"}`}>{s.label}</span>
                    {s.badge ? <span className="min-w-0 truncate rounded-chip bg-fill-2 px-1.5 py-px text-micro text-fg-3">{s.badge}</span> : null}
                  </span>
                  {/* A service that can't be picked here says why on its second line. */}
                  {usable ? (
                    s.blurb ? <span className="mt-0.5 block truncate text-caption text-fg-3">{s.blurb}</span> : null
                  ) : (
                    <span className="mt-0.5 block text-caption text-fg-3">{s.hint}</span>
                  )}
                </span>
                <Status service={s} saving={saving && open === s.name} />
              </button>
              {expanded ? <KeyBox service={s} disabled={disabled} onSave={(keys) => pick(s, keys)} /> : null}
            </div>
          );
        })}
        {rest.length ? (
          <button
            type="button"
            aria-expanded={more}
            onClick={() => setMore((v) => !v)}
            className="press flex min-h-11 w-full items-center justify-center gap-1.5 border-t border-line text-callout text-fg-3 hover:bg-fill-1 hover:text-fg"
          >
            {more ? "Fewer services" : `More services (${rest.length})`}
            <ChevronDownIcon className={`size-4 transition-transform duration-fast ${more ? "rotate-180" : ""}`} />
          </button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 px-1 text-callout text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Status({ service, saving }: { service: ToolService; saving: boolean }) {
  if (saving) return <span className="shimmer-text shrink-0 text-caption">saving…</span>;
  if (service.active) return <span className="shrink-0 rounded-chip bg-ok/15 px-1.5 py-0.5 text-caption font-medium text-ok">in use</span>;
  if (service.status === "ready") return <span className="shrink-0 text-caption text-fg-3">{service.searchOnly ? "search only" : "ready"}</span>;
  if (service.status === "needs_keys") return <span className="shrink-0 rounded-chip bg-warn/15 px-1.5 py-0.5 text-caption text-warn">add key</span>;
  return null;
}

/** The service's key (or address, for a self-hosted one), saved to the chief's profile, then the service is used. */
function KeyBox({ service, disabled, onSave }: { service: ToolService; disabled: boolean; onSave: (keys: Record<string, string>) => Promise<void> }) {
  const missing = service.keys.filter((k) => !k.set);
  const asked = missing.length ? missing : service.keys.slice(0, 1);
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState(false);
  const filled = asked.every((k) => (values[k.key] || "").trim());
  const link = asked.find((k) => k.url)?.url;

  async function submit() {
    if (!filled) return;
    try {
      await onSave(Object.fromEntries(asked.map((k) => [k.key, values[k.key].trim()])));
      setValues({});
    } catch {
      // The list shows the error.
    }
  }

  return (
    <div className="space-y-2 border-t border-line bg-black/20 px-3 py-3">
      {asked.map((k) => {
        const address = /URL$/.test(k.key);
        return (
          <div key={k.key} className="flex gap-2">
            <input
              type={reveal || address ? "text" : "password"}
              value={values[k.key] || ""}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              placeholder={address ? "https://…" : "API key"}
              aria-label={`${service.label}: ${k.label}`}
              onChange={(e) => setValues((v) => ({ ...v, [k.key]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              className={field({ mono: true, extra: "min-w-0 flex-1" })}
            />
            {address ? null : (
              <button type="button" className="chat-type-btn min-h-11 px-3" disabled={disabled} onClick={() => setReveal((v) => !v)}>
                {reveal ? "Hide" : "Show"}
              </button>
            )}
          </div>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {link ? (
          <a href={link} target="_blank" rel="noreferrer" className="text-caption text-fg-3 underline-offset-2 hover:text-fg hover:underline">
            Get a key at {host(link)}
          </a>
        ) : (
          <span className="text-caption text-fg-3">{service.hint}</span>
        )}
        <button type="button" className={btn("primary", "md")} disabled={disabled || !filled} onClick={() => void submit()}>
          Save and use
        </button>
      </div>
    </div>
  );
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "the service’s site";
  }
};

/** Runs the real tool once and shows what came back: the picture, or the first few search results. */
function TryIt({ tool, enabled, label, busy, note }: { tool: ToolName; enabled: boolean; label: string; busy: string; note: string }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ToolTestResult | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      setResult(await testTool(tool));
    } catch (err) {
      setResult({ ok: false, error: err instanceof Error ? err.message : "The test couldn't run" });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Button variant="secondary" size="sm" icon={<SparklesIcon className="size-4" />} disabled={!enabled || running} onClick={() => void run()}>
          {label}
        </Button>
        <p className={`min-w-0 flex-1 text-caption ${running ? "shimmer-text" : "text-fg-3"}`} aria-live="polite">
          {running ? busy : note}
        </p>
      </div>
      {result?.ok && result.image ? <MessageMedia attachments={[result.image]} /> : null}
      {result?.ok && result.results?.length ? (
        <ul className="space-y-1.5 rounded-ctl bg-fill-1 px-3 py-2.5">
          {result.results.map((r) => (
            <li key={r.url} className="min-w-0">
              <a href={r.url} target="_blank" rel="noreferrer" className="block truncate text-callout text-fg-2 underline-offset-2 hover:text-fg hover:underline">
                {r.title}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {result && !result.ok ? (
        <p role="alert" className="text-callout text-danger">
          {result.error || "The test didn’t work."}
        </p>
      ) : null}
    </div>
  );
}
