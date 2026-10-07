"use client";

import { useEffect, useState, type ReactNode } from "react";

import { CircleAlertIcon, CircleCheckIcon, DownloadIcon } from "@/components/icons";
import { SwitchRow } from "@/components/settings/shared";
import { desktop, type UpdateOptions, type UpdateState } from "@/lib/desktop";
import { useAssistantName } from "@/lib/identity";
import { field } from "@/components/ui/field";

type UpdatesApi = NonNullable<ReturnType<typeof desktop>>["updates"];

/** The shell's update state and options, live. `null` outside the desktop app (a browser or the phone never updates). */
export function useUpdates(): { state: UpdateState | null; api: UpdatesApi | null; options: UpdateOptions | null } {
  const api = desktop()?.updates ?? null;
  const [state, setState] = useState<UpdateState | null>(null);
  const [options, setOptions] = useState<UpdateOptions | null>(null);
  useEffect(() => {
    if (!api) return;
    void api.state().then(setState).catch(() => undefined);
    void api.options?.().then(setOptions).catch(() => undefined);
    return api.onState(setState);
  }, [api]);
  return { state, api, options };
}

const mb = (n: number) => `${Math.max(1, Math.round(n / 1e6))} MB`;

/** States the floating card shows (it stays quiet while an update prepares in the background). */
function floats(state: UpdateState, autoPrepare: boolean): boolean {
  if (["ready", "busy", "restarting"].includes(state.status)) return true;
  if (state.status === "error") return !!state.release;
  // With the background prepare on, "available" and the download only last until it starts; Settings shows them.
  return !autoPrepare && ["available", "downloading", "preparing"].includes(state.status);
}

/**
 * "Update available" (PLAN §8; docs/PLAN-2026-10-07 §1). Getting an update downloads it (verified against the signed
 * release), backs up when it brings a different Hermes and has Windows unpack it, all while Chief keeps working;
 * the restart is the owner's click and never interrupts a turn unless the owner chooses "Restart now".
 */
export function UpdateCard({ compact = false, onLater }: { compact?: boolean; onLater?: () => void }) {
  const assistant = useAssistantName();
  const { state, api, options } = useUpdates();
  const [acting, setActing] = useState(false);
  if (!api || !state) return null;
  const act = async (fn: () => Promise<unknown>) => {
    setActing(true);
    try {
      await fn();
    } finally {
      setActing(false);
    }
  };

  if (compact && !floats(state, options?.prepare ?? true)) return null;

  const content = (() => {
    switch (state.status) {
      case "idle":
      case "checking":
        return <Line tone="idle">{state.status === "checking" ? "Checking for updates…" : "Updates haven't been checked yet."}</Line>;
      case "up-to-date":
        return (
          <Row>
            <Line tone="ok">Up to date (checked {new Date(state.checkedAt).toLocaleString()}).</Line>
            <Button subtle disabled={acting} onClick={() => void act(() => api.check())}>
              Check now
            </Button>
          </Row>
        );
      case "error":
        return (
          <div className="space-y-2">
            <Line tone="error">{state.error}</Line>
            <Row>
              <Button subtle disabled={acting} onClick={() => void act(() => (state.release ? api.prepare() : api.check()))}>
                {state.release ? "Try again" : "Retry"}
              </Button>
              {compact && onLater ? (
                <Button subtle disabled={acting} onClick={onLater}>
                  Dismiss
                </Button>
              ) : null}
            </Row>
          </div>
        );
      case "downloading":
        return (
          <Progress
            label={`Downloading ${state.release.version}…`}
            pct={(state.done / state.total) * 100}
            detail={`${mb(state.done)} of ${mb(state.total)} · ${assistant} keeps working.`}
          />
        );
      case "preparing":
        return state.step === "backup" ? (
          <Progress label={`Backing up before ${state.release.version}…`} pct={state.pct} detail={`It brings a new Hermes, so your setup is saved first. ${assistant} keeps working.`} />
        ) : (
          <Progress label={`Getting ${state.release.version} ready…`} pct={state.pct} detail={`Windows is unpacking it beside the current version. ${assistant} keeps working.`} />
        );
      case "restarting":
        return <Progress label={state.step} pct={null} detail={`${assistant} will be back in a moment.`} />;
      case "busy":
        return (
          <div className="space-y-2">
            <Line tone="warn">
              {state.reasons.join(" ")} Restarting stops {assistant}.
            </Line>
            <Row>
              <Button
                disabled={acting}
                onClick={() =>
                  void act(async () => {
                    // Wait for the turn to finish, then restart; nothing is interrupted.
                    let s = await api.restart(false);
                    while (s.status === "busy") {
                      await new Promise((r) => setTimeout(r, 5000));
                      s = await api.restart(false);
                    }
                  })
                }
              >
                {acting ? `Waiting for ${assistant}…` : `Restart when ${assistant}'s done`}
              </Button>
              <Button subtle disabled={acting} onClick={() => void act(() => api.restart(true))}>
                Restart now
              </Button>
              {onLater ? (
                <Button subtle disabled={acting} onClick={onLater}>
                  Later
                </Button>
              ) : null}
            </Row>
          </div>
        );
      case "ready":
        return (
          <div className="space-y-2" role="region" aria-label="Update ready">
            <p className="flex items-center gap-2 text-body font-medium text-fg">
              <CircleCheckIcon className="size-4 text-ok" />
              {state.older ? `Older version ${state.release.version} is ready` : `Version ${state.release.version} is ready`}
            </p>
            <p className="text-callout text-fg-3">
              {state.staged ? "Restarting takes about twenty seconds" : "Restarting takes about a minute"}; {assistant} reopens by itself.
            </p>
            {state.release.notes && !compact ? <p className="whitespace-pre-wrap text-callout text-fg-2">{state.release.notes}</p> : null}
            <Row>
              <Button disabled={acting} onClick={() => void act(() => api.restart(false))}>
                {state.older ? `Restart into ${state.release.version}` : "Restart to update"}
              </Button>
              {onLater ? (
                <Button subtle disabled={acting} onClick={onLater}>
                  Later
                </Button>
              ) : null}
            </Row>
          </div>
        );
      default: {
        const release = state.release;
        return (
          <div className="space-y-2" role="region" aria-label="Update available">
            <p className="flex items-center gap-2 text-body font-medium text-fg">
              <DownloadIcon className="size-4 text-accent-text" />
              Update available
            </p>
            <p className="text-callout text-fg-3">
              Version {release.version}
              {release.hermes?.base_version ? ` · Hermes ${release.hermes.base_version}` : ""} · {mb(release.package.bytes)}. It gets ready while {assistant} keeps
              working; you choose when to restart.
            </p>
            {release.notes && !compact ? <p className="whitespace-pre-wrap text-callout text-fg-2">{release.notes}</p> : null}
            <Row>
              <Button disabled={acting} onClick={() => void act(() => api.prepare())}>
                Get update
              </Button>
              {onLater ? (
                <Button subtle disabled={acting} onClick={onLater}>
                  Later
                </Button>
              ) : null}
              <Button subtle disabled={acting} onClick={() => void act(() => api.skip(release.version))}>
                Skip this version
              </Button>
            </Row>
          </div>
        );
      }
    }
  })();
  // The floating card (top right of the app) gets its own surface; in Settings it sits inside its group.
  return compact ? (
    <section aria-label="App update" className="rounded-card border border-line-2 bg-raised/95 p-3.5 shadow-e4 backdrop-blur-sm">
      <p className="mb-2 text-caption font-medium text-fg-3">App update</p>
      {content}
    </section>
  ) : (
    content
  );
}

/**
 * A progress bar with a label, a percentage when known, and a soft sweep while it isn't (the sweep stops when motion
 * is reduced). `pct` 0..100 or null.
 */
function Progress({ label, pct, detail }: { label: string; pct: number | null; detail: string }) {
  const known = pct !== null && Number.isFinite(pct);
  const value = known ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
  return (
    <div className="space-y-1.5">
      <p className="flex items-baseline justify-between gap-3 text-callout text-fg-2">
        <span>{label}</span>
        {known ? <span className="font-mono text-caption tabular text-fg-3">{value}%</span> : null}
      </p>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-fill-2"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(known ? { "aria-valuenow": value } : {})}
      >
        {known ? <div className="h-full rounded-full bg-accent transition-[width] duration-medium ease-out" style={{ width: `${Math.max(value, 2)}%` }} /> : <div className="skeleton h-full w-full" />}
      </div>
      <p className="text-caption text-fg-3">{detail}</p>
    </div>
  );
}

/** `github:owner/repo` or a github.com URL: a release repository (public, or private and read with a key). */
export const isGithubFeed = (feed: string) => /^(github:|https:\/\/github\.com\/)[\w-]+\/[\w.-]+/.test(feed.trim());

/** Settings → Updates: where updates come from (a release folder, or a GitHub release repository and, if it is private, its key), and the card. */
export function UpdatesPanel() {
  const assistant = useAssistantName();
  const { api, options: loaded } = useUpdates();
  // What the owner just switched, shown at once; the shell's own copy (`loaded`) until then.
  const [chosen, setChosen] = useState<UpdateOptions | null>(null);
  const options = chosen ?? loaded;
  const choose = async (patch: Partial<UpdateOptions>) => {
    if (!options || !api?.setOptions) return;
    setChosen({ ...options, ...patch });
    await api.setOptions(patch).catch(() => setChosen(options));
  };
  const [feed, setFeed] = useState("");
  const [saved, setSaved] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [keyRefused, setKeyRefused] = useState(false);
  const [key, setKey] = useState("");
  const [feedError, setFeedError] = useState("");
  useEffect(() => {
    void api?.feed().then((f) => {
      setFeed(f);
      setSaved(f);
    });
    void api?.hasKey?.().then(setHasKey);
    void api?.keyStatus?.().then((s) => setKeyRefused(s.refused));
  }, [api]);
  if (!api) return null;
  const github = isGithubFeed(saved);
  return (
    <div className="space-y-3">
      <UpdateCard />
      {options && api.setOptions ? (
        <div className="-mx-3 divide-y divide-line-1 border-y border-line-1">
          <SwitchRow
            label="Get updates ready in the background"
            hint={`A new version downloads and gets ready while ${assistant} works. Restarting into it is always your click.`}
            checked={options.prepare}
            onChange={(next) => void choose({ prepare: next })}
          />
          <SwitchRow
            label="Early updates"
            hint="Get new versions a day or two before everyone else, to try them first. For whoever publishes the app."
            checked={options.early}
            onChange={(next) => void choose({ early: next })}
          />
        </div>
      ) : null}
      <div className="text-callout text-fg-2">
        <label htmlFor="update-feed">Update source</label>
        <div className="mt-1.5 flex gap-2">
          <input
            id="update-feed"
            value={feed}
            onChange={(e) => setFeed(e.target.value)}
            spellCheck={false}
            placeholder="github:owner/releases-repo, or a release folder"
            className={field({ mono: true, extra: "min-w-0 flex-1 py-2" })}
          />
          {feed.trim() !== saved ? (
            <Button
              onClick={async () => {
                setFeedError("");
                try {
                  await api.setFeed(feed.trim());
                  setSaved(feed.trim());
                } catch (e) {
                  // The shell refuses network shares and anything that isn't a repository or a local folder.
                  const text = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : "";
                  setFeedError(text || "That update source isn't allowed.");
                }
              }}
            >
              Save
            </Button>
          ) : null}
        </div>
        {feedError ? <p role="alert" className="mt-1 text-caption text-danger">{feedError}</p> : null}
        <p className="mt-1 text-caption text-fg-3">Only releases signed by this app&apos;s publisher are offered, and nothing installs without your click.</p>
      </div>
      {github && api.setKey ? (
        <div className="text-callout text-fg-2">
          <label htmlFor="update-key">Update key (only for a private release repository)</label>
          <div className="mt-1.5 flex gap-2">
            <input
              id="update-key"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              spellCheck={false}
              placeholder={hasKey ? "A key is saved; paste a new one to replace it" : "Not needed for a public release repository"}
              className={field({ mono: true, extra: "min-w-0 flex-1 py-2" })}
            />
            {key.trim() ? (
              <Button
                onClick={async () => {
                  await api.setKey!(key.trim());
                  setKey("");
                  setHasKey(true);
                }}
              >
                Save key
              </Button>
            ) : null}
          </div>
          <p className="mt-1 text-caption text-fg-3">
            {hasKey ? "Saved and protected by Windows for your account. " : ""}A key only lets this app read new releases from a private repository; a public one needs none.
          </p>
          {hasKey && keyRefused ? (
            <p role="status" className="mt-1.5 text-caption text-warn">
              GitHub no longer accepts the saved key, and this release repository doesn&apos;t need one. Updates work without it; remove it to tidy up.
            </p>
          ) : null}
          {hasKey && api.setKey ? (
            <div className="mt-2">
              <Button
                subtle
                onClick={async () => {
                  await api.setKey!("");
                  setHasKey(false);
                  setKeyRefused(false);
                }}
              >
                Remove key
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function Line({ tone, children }: { tone: "ok" | "warn" | "error" | "idle"; children: ReactNode }) {
  const Icon = tone === "ok" ? CircleCheckIcon : CircleAlertIcon;
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-2 text-callout ${tone === "error" ? "text-danger" : tone === "idle" ? "text-fg-3" : "text-fg-2"}`}>
      {tone === "idle" ? null : <Icon className={`mt-0.5 size-4 shrink-0 ${tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : ""}`} />}
      <span>{children}</span>
    </p>
  );
}

function Button({ children, onClick, disabled, subtle }: { children: ReactNode; onClick: () => void; disabled?: boolean; subtle?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`press min-h-10 rounded-full px-4 text-callout font-medium disabled:opacity-50 ${subtle ? "border border-line-2 text-fg-2 hover:text-fg" : "bg-fg text-canvas"}`}
    >
      {children}
    </button>
  );
}
