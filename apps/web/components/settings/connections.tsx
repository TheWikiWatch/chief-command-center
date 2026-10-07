"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { BriefcaseIcon, CalendarIcon, CheckIcon, ChevronDownIcon, ExternalLinkIcon, HardDriveIcon, LockIcon, MailIcon, RefreshCwIcon, SearchIcon, ShieldCheckIcon, ZapIcon } from "@/components/icons";
import { Button, btn } from "@/components/ui/button";
import { field } from "@/components/ui/field";
import { Group } from "@/components/ui/settings-group";
import {
  BACKEND_LABEL,
  cancelNousSignIn,
  disconnectService,
  fetchConnections,
  onThisPc,
  openSignIn,
  pollNousSignIn,
  signOutNous,
  startNousSignIn,
  useConnectFlow,
  type Backend,
  type ConnectionService,
  type ConnectionsView,
  type KeyNeed,
  type NousStart,
} from "@/lib/connections";
import { useAssistantName } from "@/lib/identity";

/*
 * Settings → Connections: the services the chief can use (worker bots get them once the mail guard runs in their
 * processes too: docs/PLAN-2026-10-07-connections.md §2.5). Each row is a service, whatever carries it (connections.py):
 * Quick (Nous Connectors), On this PC (Google, kept between this PC and Google) or Direct (Hermes's catalog). The
 * Nous sign-in at the top turns Quick on. Reading is free; sending, deleting and moving mail asks first.
 */

export function ConnectionsPage() {
  const chief = useAssistantName();
  const [data, setData] = useState<ConnectionsView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (refresh = true) => {
    setLoading(true);
    setError("");
    try {
      setData(await fetchConnections(refresh));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read your connections");
    } finally {
      setLoading(false);
    }
  }, []);
  const reload = useCallback(() => void load(), [load]);
  const nous = useNousSignIn(reload);

  useEffect(() => {
    let live = true;
    fetchConnections()
      .then((next) => live && setData(next))
      .catch((err) => live && setError(err instanceof Error ? err.message : "Couldn't read your connections"))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const refresh = (
    <button
      type="button"
      aria-label="Refresh"
      title="Check again"
      className="press grid size-9 place-items-center rounded-full text-fg-3 hover:bg-fill-2 hover:text-fg disabled:opacity-40"
      disabled={loading}
      onClick={() => void load()}
    >
      <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
    </button>
  );

  if (!data) {
    return loading ? (
      <div className="space-y-2" role="status" aria-label="Loading connections…">
        <div className="h-16 rounded-card bg-fill-1" />
        <div className="h-40 rounded-card bg-fill-1" />
      </div>
    ) : (
      <div className="flex items-center gap-3 rounded-ctl bg-fill-1 px-3 py-2.5">
        <p role="alert" className="min-w-0 flex-1 text-callout text-fg-2">
          {error || "Couldn't read your connections."}
        </p>
        {refresh}
      </div>
    );
  }

  const mail = data.services.filter((s) => s.group === "mail");
  const work = data.services.filter((s) => s.group === "work");
  return (
    <>
      <NousGroup view={data} signin={nous} action={refresh} />
      {data.warning ? <p className="-mt-2 px-1 text-caption text-warn">{data.warning}</p> : null}
      <Group icon={<MailIcon className="size-4" />} title="Email and calendar" hint={`Mail, calendars and documents for ${chief}. Reading is free; sending, deleting and moving mail asks you first.`}>
        {mail.map((s) => (
          <ServiceRow key={s.id} service={s} view={data} onChange={reload} onNous={nous.session || nous.busy ? undefined : () => void nous.signIn()} />
        ))}
      </Group>
      {work.length ? <WorkGroup services={work} featured={data.featured} view={data} onChange={reload} /> : null}
      <SafetyNote />
    </>
  );
}

/* ------------------------------------------------------------------ Nous */

/** The Nous sign-in (device code): started from the Quick connections group or from a row that needs it. */
function useNousSignIn(onChange: () => void) {
  const [session, setSession] = useState<NousStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!session) return;
    let live = true;
    const timer = window.setInterval(() => {
      pollNousSignIn(session.session)
        .then((res) => {
          if (!live || res.status === "pending") return;
          setSession(null);
          if (res.status === "approved") onChange();
          else setError(res.status === "error" ? res.error || "The Nous sign-in didn't finish." : res.status === "denied" ? "The sign-in was declined." : "The code expired. Try again.");
        })
        .catch(() => undefined);
    }, 2000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [session, onChange]);

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const started = await startNousSignIn();
      setSession(started);
      openSignIn(started.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start the Nous sign-in");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      await signOutNous();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign out");
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    if (session) void cancelNousSignIn(session.session);
    setSession(null);
  }

  return { session, busy, error, signIn, signOut, cancel };
}

type NousSignIn = ReturnType<typeof useNousSignIn>;

function NousGroup({ view, signin, action }: { view: ConnectionsView; signin: NousSignIn; action: ReactNode }) {
  const { session, busy, error, signIn, signOut, cancel } = signin;
  const nous = view.nous;
  const status = nous.signedIn
    ? nous.connectors
      ? `Signed in${nous.account ? ` as ${nous.account}` : ""}. Quick connections are on.`
      : `Signed in${nous.account ? ` as ${nous.account}` : ""}, but this account doesn’t offer quick connections yet.`
    : "One free Nous account turns on one-click Gmail, Outlook, Calendar, Drive and more. No developer accounts or keys.";

  return (
    <Group icon={<ZapIcon className="size-4" />} title="Quick connections" action={action}>
      <div className="space-y-3 p-3.5">
        <div className="flex items-start gap-3">
          <Tile tone={nous.connectors ? "ok" : "plain"}>
            <ZapIcon className="size-[18px]" />
          </Tile>
          <div className="min-w-0 flex-1">
            <p className="text-body text-fg">{nous.signedIn ? "Nous account" : "Sign in to Nous"}</p>
            <p className="mt-0.5 text-caption text-fg-3">{status}</p>
          </div>
          {nous.signedIn ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void signOut()}>
              Sign out
            </Button>
          ) : session ? null : (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => void signIn()}>
              {busy ? "Starting…" : "Sign in"}
            </Button>
          )}
        </div>
        {session ? (
          <div className="rounded-ctl border border-line bg-well px-3 py-3">
            <p className="text-callout text-fg-2">Nous opened in your browser. If it asks for a code, enter:</p>
            <p className="my-2 font-mono text-title tracking-widest text-fg" aria-label={`Code ${session.code.split("").join(" ")}`}>
              {session.code}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <a href={session.url} target="_blank" rel="noreferrer" className={btn("secondary", "sm")}>
                Open Nous <ExternalLinkIcon className="size-3.5" />
              </a>
              <Button variant="ghost" size="sm" onClick={cancel}>
                Cancel
              </Button>
              <span className="shimmer-text text-caption" aria-live="polite">
                Waiting for you to approve…
              </span>
            </div>
          </div>
        ) : null}
        {!nous.signedIn ? (
          <p className="text-caption text-fg-3">Quick connections go through Nous Research and Composio, which keep the sign-in and pass a bot what it asks for. For Google you can keep everything on this PC instead.</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-callout text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Group>
  );
}

/* ------------------------------------------------------------------ work tools */

function WorkGroup({ services, featured, view, onChange }: { services: ConnectionService[]; featured: string[]; view: ConnectionsView; onChange: () => void }) {
  const [all, setAll] = useState(false);
  const [query, setQuery] = useState("");
  const top = services.filter((s) => featured.includes(s.id) || s.state !== "not_connected");
  const shown = useMemo(() => {
    if (!all) return top;
    const q = query.trim().toLowerCase();
    return q ? services.filter((s) => s.label.toLowerCase().includes(q) || s.blurb.toLowerCase().includes(q)) : services;
  }, [all, query, services, top]);
  const rest = services.length - top.length;
  return (
    <Group icon={<BriefcaseIcon className="size-4" />} title="Work tools" hint="Each opens its own sign-in page; nothing to register. These connect directly from this PC.">
      {all ? (
        <div className="p-2.5">
          <label className="relative block">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a tool"
              aria-label="Find a work tool"
              className={field({ extra: "w-full pl-9" })}
            />
          </label>
        </div>
      ) : null}
      {shown.map((s) => (
        <ServiceRow key={s.id} service={s} view={view} onChange={onChange} />
      ))}
      {all && !shown.length ? <p className="px-3.5 py-4 text-callout text-fg-3">No tool matches “{query}”.</p> : null}
      {rest > 0 ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => {
            setAll((v) => !v);
            setQuery("");
          }}
          className="press flex min-h-11 w-full items-center justify-center gap-1.5 text-callout text-fg-3 hover:bg-fill-1 hover:text-fg"
        >
          {all ? "Fewer tools" : `All work tools (${services.length})`}
          <ChevronDownIcon className={`size-4 transition-transform duration-fast ${all ? "rotate-180" : ""}`} />
        </button>
      ) : null}
    </Group>
  );
}

/* ------------------------------------------------------------------ one service */

const BACKEND_NOTE: Record<Backend, string> = {
  quick: "One click, from any device. Nous and Composio keep the sign-in.",
  local: "Google shows an “unverified app” screen once. Your mail goes only between this PC and Google.",
  mcp: "The service’s own sign-in. Stays on this PC.",
};

export function ServiceRow({ service, view, onChange, onNous }: { service: ConnectionService; view: ConnectionsView; onChange: () => void; onNous?: () => void }) {
  const { flow, start, cancel, reset } = useConnectFlow(service.id, onChange);
  const [choosing, setChoosing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connected = service.state === "connected";

  async function disconnect() {
    setBusy(true);
    setError("");
    try {
      await disconnectService(service.id);
      setConfirm(false);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't disconnect");
    } finally {
      setBusy(false);
    }
  }

  function connect() {
    setError("");
    reset();
    if (service.backends.length > 1) return setChoosing((v) => !v);
    void start(service.backends[0]);
  }

  const sub = connected
    ? [service.via ? BACKEND_LABEL[service.via] : "", service.account || ""].filter(Boolean).join(" · ")
    : service.state === "reconnect"
      ? "The sign-in expired. Reconnect to keep using it."
      : service.needsNous
        ? "Needs a free Nous account."
        : service.blurb;
  const otherGoogle = service.via === "local" ? view.services.filter((s) => s.via === "local" && s.id !== service.id).map((s) => s.label) : [];

  return (
    <div className="px-3.5 py-3">
      <div className="flex items-center gap-3">
        <ServiceTile service={service} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-body text-fg">{service.label}</p>
          <p className="mt-0.5 truncate text-caption text-fg-3">{sub}</p>
        </div>
        {connected ? (
          <>
            <span className="hidden shrink-0 items-center gap-1 rounded-chip bg-ok/15 px-1.5 py-0.5 text-caption font-medium text-ok sm:inline-flex">
              <CheckIcon className="size-3" strokeWidth={3} /> Connected
            </span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm((v) => !v)}>
              Disconnect
            </Button>
          </>
        ) : flow.step === "waiting" || flow.step === "starting" ? null : !service.backends.length ? (
          service.needsNous && onNous ? (
            <Button variant="ghost" size="sm" onClick={onNous}>
              Sign in to Nous
            </Button>
          ) : null
        ) : (
          <Button variant={service.state === "reconnect" ? "primary" : "secondary"} size="sm" onClick={connect} aria-expanded={service.backends.length > 1 ? choosing : undefined}>
            {service.state === "reconnect" ? "Reconnect" : "Connect"}
            {service.backends.length > 1 ? <ChevronDownIcon className={`size-3.5 transition-transform duration-fast ${choosing ? "rotate-180" : ""}`} /> : null}
          </Button>
        )}
      </div>

      {confirm ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-ctl bg-fill-1 px-3 py-2.5">
          <p className="min-w-0 flex-1 text-callout text-fg-2">
            Disconnect {service.label}? Bots lose access{otherGoogle.length ? `, and ${otherGoogle.join(" and ")} on this PC go too` : ""}.
          </p>
          <Button variant="danger" size="sm" disabled={busy} onClick={() => void disconnect()}>
            {busy ? "Disconnecting…" : "Disconnect"}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirm(false)}>
            Keep
          </Button>
        </div>
      ) : null}

      {choosing && !connected && flow.step === "idle" ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {service.backends.map((b, i) => (
            <button
              key={b}
              type="button"
              onClick={() => {
                setChoosing(false);
                void start(b);
              }}
              className="press flex flex-col items-start gap-1 rounded-ctl border border-line-2 bg-well px-3 py-2.5 text-left hover:border-line-3 hover:bg-fill-1"
            >
              <span className="flex items-center gap-1.5 text-callout font-medium text-fg">
                {b === "local" || b === "mcp" ? <LockIcon className="size-3.5 text-fg-3" /> : <ZapIcon className="size-3.5 text-fg-3" />}
                {BACKEND_LABEL[b]}
                {i === 0 && b === "quick" ? <span className="rounded-chip bg-fill-2 px-1.5 py-px text-micro font-normal text-fg-3">recommended</span> : null}
              </span>
              <span className="text-caption text-fg-3">{BACKEND_NOTE[b]}</span>
            </button>
          ))}
        </div>
      ) : null}

      <FlowNote flow={flow} label={service.label} onCancel={cancel} onRetry={connect} onKeys={(env, backend) => void start(backend, env)} />
      {error ? (
        <p role="alert" className="mt-2 text-callout text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** What a connect flow is doing, under its row or inside the chat card. */
export function FlowNote({
  flow,
  label,
  onCancel,
  onRetry,
  onKeys,
}: {
  flow: ReturnType<typeof useConnectFlow>["flow"];
  label: string;
  onCancel: () => void;
  onRetry: () => void;
  onKeys: (env: Record<string, string>, backend: Backend) => void;
}) {
  if (flow.step === "starting") return <p className="shimmer-text mt-2 text-caption">Opening the {label} sign-in…</p>;
  if (flow.step === "waiting") {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-ctl bg-fill-1 px-3 py-2.5">
        <p className="shimmer-text min-w-0 flex-1 text-callout" aria-live="polite">
          Finish signing in to {label} in your browser…
        </p>
        <a href={flow.url} target="_blank" rel="noreferrer" className={btn("secondary", "sm")}>
          Open again <ExternalLinkIcon className="size-3.5" />
        </a>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  }
  if (flow.step === "pc-only") {
    return (
      <div className="mt-3 flex items-start gap-2.5 rounded-ctl bg-fill-1 px-3 py-2.5">
        <LockIcon className="mt-0.5 size-4 shrink-0 text-fg-3" />
        <p className="min-w-0 flex-1 text-callout text-fg-2">
          {flow.backend === "local" ? "Keeping Google on this PC" : `Connecting ${label} directly`} finishes in a browser on your PC. Open Chief there and connect it from Settings → Connections.
        </p>
      </div>
    );
  }
  if (flow.step === "keys") return <KeysBox needs={flow.needs} label={label} onSave={(env) => onKeys(env, flow.backend)} onCancel={onCancel} />;
  if (flow.step === "done") {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-callout text-ok" role="status">
        <CheckIcon className="size-4" strokeWidth={2.5} /> {label} is connected.
      </p>
    );
  }
  if (flow.step === "failed") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <p role="alert" className="min-w-0 flex-1 text-callout text-danger">
          {flow.error}
        </p>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  return null;
}

function KeysBox({ needs, label, onSave, onCancel }: { needs: KeyNeed[]; label: string; onSave: (env: Record<string, string>) => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const filled = needs.every((n) => (values[n.name] || "").trim());
  return (
    <div className="mt-3 space-y-2 rounded-ctl border border-line bg-well px-3 py-3">
      <p className="text-caption text-fg-3">{label} needs this to connect. It’s saved to your chief’s profile on this PC and never shown again.</p>
      {needs.map((n) => (
        <input
          key={n.name}
          type={n.secret ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          value={values[n.name] || ""}
          placeholder={n.prompt}
          aria-label={`${label}: ${n.prompt}`}
          onChange={(e) => setValues((v) => ({ ...v, [n.name]: e.target.value }))}
          className={field({ mono: n.secret, extra: "w-full" })}
        />
      ))}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!filled} onClick={() => onSave(Object.fromEntries(needs.map((n) => [n.name, values[n.name].trim()])))}>
          Connect
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ bits */

type Tone = "mail" | "calendar" | "drive" | "outlook" | "ok" | "plain";

const TONE: Record<Tone, string> = {
  mail: "text-danger",
  calendar: "text-data",
  drive: "text-warn",
  outlook: "text-data",
  ok: "text-ok",
  plain: "text-fg-2",
};

function Tile({ tone = "plain", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`grid size-9 shrink-0 place-items-center rounded-ctl bg-fill-2 ${TONE[tone]}`}>{children}</span>;
}

export function ServiceTile({ service }: { service: Pick<ConnectionService, "id" | "label"> }) {
  const icon: Record<string, [Tone, ReactNode]> = {
    gmail: ["mail", <MailIcon key="i" className="size-[18px]" />],
    googlecalendar: ["calendar", <CalendarIcon key="i" className="size-[18px]" />],
    googledrive: ["drive", <HardDriveIcon key="i" className="size-[18px]" />],
    outlook: ["outlook", <MailIcon key="i" className="size-[18px]" />],
  };
  const known = icon[service.id];
  if (known) return <Tile tone={known[0]}>{known[1]}</Tile>;
  return (
    <Tile>
      <span className="text-callout font-semibold">{service.label.charAt(0).toUpperCase()}</span>
    </Tile>
  );
}

function SafetyNote() {
  const chief = useAssistantName();
  return (
    <div className="flex items-start gap-2.5 rounded-ctl bg-fill-1 px-3 py-2.5">
      <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-ok" />
      <p className="min-w-0 flex-1 text-caption text-fg-3">
        {chief} can search and read what you connect. Sending, replying, forwarding, deleting or moving mail, inviting people and sharing files
        always ask you first, with who it goes to and what it says. Email is treated as untrusted: a message can’t tell a bot to skip that.
        {onThisPc() ? null : " Some connections finish on your PC."}
      </p>
    </div>
  );
}

