"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { ArrowLeftIcon, CircleAlertIcon, CircleCheckIcon, ChevronDownIcon, SearchIcon, TerminalIcon, ZapIcon } from "@/components/icons";
import { setup, sortProviders, type Catalog, type ProviderRow, type SetupStatus } from "@/lib/setup-client";
import { field } from "@/components/ui/field";
import { btn } from "@/components/ui/button";

type Stage =
  | { name: "choose" }
  | { name: "key"; provider: ProviderRow }
  | { name: "model"; provider: ProviderRow; models: string[]; recommended: string }
  | { name: "endpoint" }
  | { name: "done"; provider: string; model: string; reply: string }
  | { name: "added"; provider: string };

/**
 * Connect the chief to a model: a key-based provider from Hermes's own catalog, or a custom / local
 * OpenAI-compatible endpoint (a key is optional there). Every step says what went wrong and offers a
 * way forward; nothing here ever shows a saved key again.
 */
/**
 * `addOnly`: connect another provider (a key, or a local endpoint) without switching the chief to it. Its
 * models then show in every bot's model list. Used by Settings → Models & keys.
 */
export function ConnectModel({
  onDone,
  onBusy,
  addOnly = false,
  onAdded,
}: {
  onDone?: (status: SetupStatus) => void;
  onBusy?: (busy: boolean) => void;
  addOnly?: boolean;
  onAdded?: (provider: string) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState("");
  const [stage, setStage] = useState<Stage>({ name: "choose" });
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);

  const load = () => {
    setLoadError("");
    setup
      .providers()
      .then(setCatalog)
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : "Couldn't load providers."));
  };
  useEffect(load, []);
  // Move focus to each new step's heading, so keyboard and screen-reader users follow along.
  useEffect(() => heading.current?.focus(), [stage.name]);
  useEffect(() => onBusy?.(testing), [testing, onBusy]);
  const go = (next: Stage) => {
    setTestError("");
    setStage(next);
  };

  /** One tiny completion through the chief's configured model. The step stays on screen meanwhile. */
  const runTest = async (provider: string, model: string) => {
    setTesting(true);
    setTestError("");
    const result = await setup.test().catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : "The test didn't finish." }));
    setTesting(false);
    if (!result.ok) {
      setTestError(result.error || "The test message failed.");
      return;
    }
    setStage({ name: "done", provider, model, reply: "reply" in result ? String(result.reply || "") : "" });
    const status = await setup.status().catch(() => null);
    onDone?.(status ?? { ready: true, provider, model, error: "" });
  };
  const test = { testing, testError };
  const added = (provider: string) => {
    setStage({ name: "added", provider });
    onAdded?.(provider);
  };
  if (stage.name === "added") {
    return (
      <Panel heading={heading} title={`${stage.provider} is connected`} subtitle="Its models are now in every bot's model list.">
        <p className="flex items-start gap-2 text-callout text-fg-2" role="status">
          <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-ok" />
          <span>Nothing else changed: each bot keeps the model it has until you pick another.</span>
        </p>
        <GhostButton onClick={() => go({ name: "choose" })}>Connect another</GhostButton>
      </Panel>
    );
  }
  if (stage.name === "done") {
    return (
      <Panel heading={heading} title="Connected" subtitle={`${stage.model} on ${stage.provider}`}>
        <p className="flex items-start gap-2 text-callout text-fg-2" role="status">
          <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-ok" />
          <span>{stage.reply ? `The model answered “${stage.reply}”.` : "The model answered."} You can change this any time in Settings.</span>
        </p>
      </Panel>
    );
  }
  if (stage.name === "key") {
    return (
      <KeyStep
        heading={heading}
        provider={stage.provider}
        onBack={() => go({ name: "choose" })}
        onConnected={(models, recommended) => (addOnly ? added(stage.provider.name) : go({ name: "model", provider: stage.provider, models, recommended }))}
      />
    );
  }
  if (stage.name === "model") {
    return (
      <ModelStep
        heading={heading}
        provider={stage.provider}
        models={stage.models}
        recommended={stage.recommended}
        {...test}
        onBack={() => go({ name: "key", provider: stage.provider })}
        onChosen={(model) => runTest(stage.provider.name, model)}
      />
    );
  }
  if (stage.name === "endpoint") {
    return (
      <EndpointStep
        heading={heading}
        {...test}
        makeDefault={!addOnly}
        onBack={() => go({ name: "choose" })}
        onSaved={async (name, model) => (addOnly ? added(name) : runTest(name, model))}
      />
    );
  }
  return (
    <ChooseStep
      heading={heading}
      catalog={catalog}
      error={loadError}
      onRetry={load}
      onPick={(provider) => go({ name: "key", provider })}
      onEndpoint={() => go({ name: "endpoint" })}
    />
  );
}

/* ---------------------------------------------------------------- steps */

function ChooseStep({
  heading,
  catalog,
  error,
  onRetry,
  onPick,
  onEndpoint,
}: {
  heading: React.RefObject<HTMLHeadingElement | null>;
  catalog: Catalog | null;
  error: string;
  onRetry: () => void;
  onPick: (p: ProviderRow) => void;
  onEndpoint: () => void;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [showExternal, setShowExternal] = useState(false);
  const groups = useMemo(() => sortProviders(catalog?.providers || []), [catalog]);
  const q = query.trim().toLowerCase();
  const match = (p: ProviderRow) => !q || p.name.toLowerCase().includes(q) || p.slug.includes(q);
  const searching = !!q;
  return (
    <Panel heading={heading} title="Connect a model" subtitle="Choose where your chief's intelligence comes from. You can change it later.">
      {error ? (
        <Problem text={error} action={<GhostButton onClick={onRetry}>Try again</GhostButton>} />
      ) : !catalog ? (
        <p className="text-callout text-fg-3" role="status">
          Loading providers…
        </p>
      ) : (
        <div className="space-y-4">
          <label className="relative block">
            <span className="sr-only">Search providers</span>
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search providers"
              className={field({ extra: "w-full pl-9 pr-3" })}
            />
          </label>
          <ul className="grid gap-2 sm:grid-cols-2" aria-label="Popular providers">
            {(searching ? [...groups.featured, ...groups.more].filter(match) : groups.featured).map((p) => (
              <ProviderButton key={p.slug} provider={p} onClick={() => onPick(p)} />
            ))}
            {!searching || "local custom endpoint ollama lm studio".includes(q) ? (
              <li>
                <button type="button" onClick={onEndpoint} className="press flex min-h-14 w-full items-center gap-3 rounded-card border border-line bg-card px-3 py-2 text-left hover:border-line-2">
                  <TerminalIcon className="size-5 shrink-0 text-fg-2" />
                  <span className="min-w-0">
                    <span className="block text-body font-medium text-fg">Local or custom endpoint</span>
                    <span className="block text-caption text-fg-3">Ollama, LM Studio, or any OpenAI-compatible URL. Key optional.</span>
                  </span>
                </button>
              </li>
            ) : null}
          </ul>
          {!searching && groups.more.length ? (
            <Disclosure open={showAll} onToggle={() => setShowAll((v) => !v)} label={`All providers (${groups.more.length})`}>
              <ul className="grid gap-2 sm:grid-cols-2">
                {groups.more.map((p) => (
                  <ProviderButton key={p.slug} provider={p} onClick={() => onPick(p)} />
                ))}
              </ul>
            </Disclosure>
          ) : null}
          {groups.external.length ? (
            <Disclosure open={showExternal} onToggle={() => setShowExternal((v) => !v)} label="Sign-in providers">
              <p className="mb-2 text-caption text-fg-3">
                These use a sign-in flow instead of a key ({groups.external.slice(0, 4).map((p) => p.name).join(", ")}…). Signing in from the app is coming soon.
              </p>
            </Disclosure>
          ) : null}
        </div>
      )}
    </Panel>
  );
}

function ProviderButton({ provider: p, onClick }: { provider: ProviderRow; onClick: () => void }) {
  return (
    <li>
      <button type="button" onClick={onClick} className="press flex min-h-14 w-full items-center gap-3 rounded-card border border-line bg-card px-3 py-2 text-left hover:border-line-2">
        <ZapIcon className="size-5 shrink-0 text-fg-2" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-fg">{p.name}</span>
          <span className="block text-caption text-fg-3">{p.connected ? "Key saved" : "API key"}</span>
        </span>
        {p.current ? <span className="rounded-full bg-ok/15 px-2 py-0.5 text-caption text-ok">In use</span> : null}
      </button>
    </li>
  );
}

function KeyStep({
  heading,
  provider,
  onBack,
  onConnected,
}: {
  heading: React.RefObject<HTMLHeadingElement | null>;
  provider: ProviderRow;
  onBack: () => void;
  onConnected: (models: string[], recommended: string) => void;
}) {
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      if (key.trim()) {
        const saved = await setup.saveKey(provider.slug, key.trim());
        if (!saved.ok) throw new Error(saved.error || "The key wasn't saved.");
      } else if (!provider.connected) {
        throw new Error("Paste your API key first.");
      }
      const models = await setup.models(provider.slug);
      if (!models.ok) throw new Error(models.error || "Couldn't list this provider's models.");
      setKey("");
      onConnected(models.models, models.recommended || models.featured[0] || models.models[0] || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel heading={heading} title={`Connect ${provider.name}`} subtitle="Your key is stored on this PC in your chief's profile. It is never shown again or sent anywhere else." onBack={onBack}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="block text-callout text-fg-2">
          API key{provider.keyEnv ? <span className="ml-1 font-mono text-caption text-fg-3">({provider.keyEnv})</span> : null}
          <span className="mt-1.5 flex gap-2">
            <input
              type={reveal ? "text" : "password"}
              value={key}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setKey(e.target.value)}
              placeholder={provider.connected ? "A key is saved. Paste a new one to replace it." : "Paste your key"}
              className={field({ mono: true, extra: "min-w-0 flex-1 placeholder:font-sans" })}
            />
            <GhostButton onClick={() => setReveal((v) => !v)}>{reveal ? "Hide" : "Show"}</GhostButton>
          </span>
        </label>
        {error ? <Problem text={error} /> : null}
        <PrimaryButton type="submit" disabled={busy || (!key.trim() && !provider.connected)}>
          {busy ? "Connecting…" : provider.connected && !key.trim() ? "Continue with the saved key" : "Connect"}
        </PrimaryButton>
      </form>
    </Panel>
  );
}

function ModelStep({
  heading,
  provider,
  models,
  recommended,
  testing,
  testError,
  onBack,
  onChosen,
}: {
  heading: React.RefObject<HTMLHeadingElement | null>;
  provider: ProviderRow;
  models: string[];
  recommended: string;
  testing: boolean;
  testError: string;
  onBack: () => void;
  onChosen: (model: string) => Promise<void>;
}) {
  const [model, setModel] = useState(recommended || models[0] || "");
  const [custom, setCustom] = useState(!models.length);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState("");
  const choose = async (confirmed = false) => {
    setBusy(true);
    setError("");
    try {
      const result = await setup.chooseModel(provider.slug, model.trim(), confirmed);
      if (result.confirm) {
        setConfirm(result.confirm);
        return;
      }
      if (!result.ok) throw new Error(result.error || "Hermes didn't accept that model.");
      setConfirm("");
      await onChosen(model.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel heading={heading} title="Choose a model" subtitle={recommended ? `Recommended for ${provider.name}: ${recommended}` : `Models offered by ${provider.name}`} onBack={onBack}>
      <div className="space-y-3">
        {custom ? (
          <label className="block text-callout text-fg-2">
            Model name
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="for example gpt-4o-mini"
              className={field({ mono: true, extra: "mt-1.5 w-full" })}
            />
          </label>
        ) : (
          <label className="block text-callout text-fg-2">
            Model
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className={field({ extra: "mt-1.5 w-full" })}
            >
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                  {m === recommended ? " (recommended)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {models.length ? (
          <button type="button" className="text-caption text-fg-3 underline decoration-line-3 underline-offset-2 hover:text-fg-2" onClick={() => setCustom((v) => !v)}>
            {custom ? "Pick from the list" : "Type a model name instead"}
          </button>
        ) : null}
        {confirm ? (
          <div className="space-y-2 rounded-card border border-warn/40 bg-warn/10 p-3">
            <p className="text-callout text-fg">{confirm}</p>
            <div className="flex gap-2">
              <PrimaryButton onClick={() => void choose(true)} disabled={busy}>
                Use it anyway
              </PrimaryButton>
              <GhostButton onClick={() => setConfirm("")}>Pick another</GhostButton>
            </div>
          </div>
        ) : null}
        {error || testError ? <Problem text={error || testError} action={<GhostButton onClick={() => void choose()}>Try again</GhostButton>} /> : null}
        <TestLine testing={testing} />
        {!confirm ? (
          <PrimaryButton onClick={() => void choose()} disabled={busy || testing || !model.trim()}>
            {busy || testing ? "Checking…" : `Use ${model.trim() || "this model"}`}
          </PrimaryButton>
        ) : null}
        <p className="text-caption text-fg-3">The app then sends one tiny test message (a few tokens) to make sure it works.</p>
      </div>
    </Panel>
  );
}

function EndpointStep({
  heading,
  testing,
  testError,
  makeDefault = true,
  onBack,
  onSaved,
}: {
  heading: React.RefObject<HTMLHeadingElement | null>;
  testing: boolean;
  testError: string;
  makeDefault?: boolean;
  onBack: () => void;
  onSaved: (name: string, model: string) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [name, setName] = useState("Local model");
  const [models, setModels] = useState<string[] | null>(null);
  const [resolved, setResolved] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const check = async () => {
    setBusy(true);
    setError("");
    setModels(null);
    try {
      const result = await setup.checkEndpoint(url.trim(), key.trim());
      if (!result.ok) throw new Error(result.error || (result.reachable ? "The endpoint answered with an error." : "Couldn't reach that address."));
      setModels(result.models);
      setResolved(result.baseUrl);
      setModel(result.models[0] || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await setup.saveEndpoint(name.trim(), resolved || url.trim(), model.trim(), key.trim(), makeDefault);
      if (!result.ok) throw new Error(result.error || "The endpoint wasn't saved.");
      setKey("");
      await onSaved(name.trim() || "Local model", model.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel heading={heading} title="Local or custom endpoint" subtitle="Any server that speaks the OpenAI API: Ollama, LM Studio, llama.cpp, vLLM, or a hosted gateway." onBack={onBack}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void (models ? save() : check());
        }}
      >
        <label className="block text-callout text-fg-2">
          Address
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setModels(null);
            }}
            inputMode="url"
            spellCheck={false}
            placeholder="http://127.0.0.1:11434/v1"
            className={field({ mono: true, extra: "mt-1.5 w-full" })}
          />
        </label>
        <label className="block text-callout text-fg-2">
          API key <span className="text-fg-3">(only if the server needs one)</span>
          <input
            type="password"
            value={key}
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
            className={field({ mono: true, extra: "mt-1.5 w-full" })}
          />
        </label>
        {models ? (
          <>
            <label className="block text-callout text-fg-2">
              Model
              {models.length ? (
                <select value={model} onChange={(e) => setModel(e.target.value)} className={field({ extra: "mt-1.5 w-full" })}>
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="The server listed no models; type one" className={field({ mono: true, extra: "mt-1.5 w-full" })} />
              )}
            </label>
            <label className="block text-callout text-fg-2">
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} className={field({ extra: "mt-1.5 w-full" })} />
            </label>
          </>
        ) : null}
        {error || testError ? <Problem text={error || testError} /> : null}
        <TestLine testing={testing} />
        <PrimaryButton type="submit" disabled={busy || testing || !url.trim() || (!!models && !model.trim())}>
          {busy || testing ? "Checking…" : models ? (makeDefault ? `Use ${model || "this model"}` : "Add this endpoint") : "Check the endpoint"}
        </PrimaryButton>
      </form>
    </Panel>
  );
}

/* ---------------------------------------------------------------- pieces */

function TestLine({ testing }: { testing: boolean }) {
  return (
    <p className="min-h-5 text-callout text-fg-2" role="status" aria-live="polite">
      {testing ? <span className="shimmer-text">Sending one tiny test message…</span> : null}
    </p>
  );
}

function Panel({
  heading,
  title,
  subtitle,
  onBack,
  children,
}: {
  heading: React.RefObject<HTMLHeadingElement | null>;
  title: string;
  subtitle?: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-start gap-2">
        {onBack ? (
          <button type="button" onClick={onBack} aria-label="Back" className="press -ml-1 grid size-9 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-fill-2 hover:text-fg">
            <ArrowLeftIcon className="size-4" />
          </button>
        ) : null}
        <div className="min-w-0">
          <h2 ref={heading} tabIndex={-1} className="text-title text-fg outline-hidden">
            {title}
          </h2>
          {subtitle ? <p className="mt-1 text-callout text-fg-3">{subtitle}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function Disclosure({ open, onToggle, label, children }: { open: boolean; onToggle: () => void; label: string; children: ReactNode }) {
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={onToggle} className="press flex min-h-10 items-center gap-1.5 text-callout text-fg-2 hover:text-fg">
        <ChevronDownIcon className={`size-4 transition-transform duration-fast ${open ? "" : "-rotate-90"}`} />
        {label}
      </button>
      {open ? <div className="mt-2">{children}</div> : null}
    </div>
  );
}

function Problem({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-card border border-danger/30 bg-danger/10 p-3" role="alert">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
      <p className="min-w-0 flex-1 text-callout text-fg">{text}</p>
      {action}
    </div>
  );
}

function PrimaryButton({ children, onClick, disabled, type = "button" }: { children: ReactNode; onClick?: () => void; disabled?: boolean; type?: "button" | "submit" }) {
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={btn("primary", "md")}>
      {children}
    </button>
  );
}

function GhostButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={btn("secondary", "md", "shrink-0")}>
      {children}
    </button>
  );
}
