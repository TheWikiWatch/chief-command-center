"use client";

import { useEffect, useState, type ReactNode } from "react";

import { CircleAlertIcon, CircleCheckIcon, DownloadIcon } from "@/components/icons";
import { desktop, type UpdateState } from "@/lib/desktop";
import { useAssistantName } from "@/lib/identity";

/** The shell's update state, live. `null` outside the desktop app (a browser or the phone never updates). */
export function useUpdates(): { state: UpdateState | null; api: NonNullable<ReturnType<typeof desktop>>["updates"] | null } {
  const api = desktop()?.updates ?? null;
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    if (!api) return;
    void api.state().then(setState).catch(() => undefined);
    return api.onState(setState);
  }, [api]);
  return { state, api };
}

const mb = (n: number) => `${Math.max(1, Math.round(n / 1e6))} MB`;

/**
 * "Update available — install?" (PLAN §8). Install downloads (verified against the signed release),
 * backs up, and hands the package to Windows. Chief's current turn is never interrupted unless the owner
 * chooses "Install now".
 */
export function UpdateCard({ compact = false, onLater }: { compact?: boolean; onLater?: () => void }) {
  const assistant = useAssistantName();
  const { state, api } = useUpdates();
  const [acting, setActing] = useState(false);
  if (!api || !state) return null;
  const act = async (fn: () => Promise<UpdateState>) => {
    setActing(true);
    try {
      await fn();
    } finally {
      setActing(false);
    }
  };
  const install = async (force = false) => {
    let s = state;
    if (s.status === "available" || (s.status === "error" && s.release)) s = await api.download();
    if (s.status === "ready" || s.status === "busy") await api.install(force);
  };

  if (compact && !["available", "downloading", "ready", "busy", "installing"].includes(state.status)) return null;

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
            <Button subtle disabled={acting} onClick={() => void act(() => (state.release ? install() : api.check()).then(() => api.state()))}>
              {state.release ? "Try again" : "Retry"}
            </Button>
          </Row>
        </div>
      );
    case "installing":
      return <Line tone="idle">{state.step} {assistant} will be back in a moment.</Line>;
    case "downloading":
      return (
        <div className="space-y-1.5">
          <p className="text-callout text-fg-2">Downloading {state.release.version}…</p>
          <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]" role="progressbar" aria-label="Update download" aria-valuemin={0} aria-valuemax={state.total} aria-valuenow={state.done}>
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((state.done / state.total) * 100)}%` }} />
          </div>
          <p className="font-mono text-caption tabular text-fg-3">
            {mb(state.done)} of {mb(state.total)}
          </p>
        </div>
      );
    case "busy":
      return (
        <div className="space-y-2">
          <Line tone="warn">
            {state.reasons.join(" ")} Installing stops {assistant}.
          </Line>
          <Row>
            <Button
              disabled={acting}
              onClick={() =>
                void act(async () => {
                  // Wait for the turn to finish, then install; nothing is interrupted.
                  let s = await api.install(false);
                  while (s.status === "busy") {
                    await new Promise((r) => setTimeout(r, 5000));
                    s = await api.install(false);
                  }
                  return s;
                })
              }
            >
              {acting ? `Waiting for ${assistant}…` : `Install when ${assistant}'s done`}
            </Button>
            <Button subtle disabled={acting} onClick={() => void act(async () => (await api.install(true), api.state()))}>
              Install now
            </Button>
            <Button subtle disabled={acting} onClick={() => onLater?.()}>
              Later
            </Button>
          </Row>
        </div>
      );
    default: {
      const release = state.release;
      return (
        <div className={`space-y-2 ${compact ? "rounded-card border border-line-2 bg-pane px-4 py-3 shadow-lg" : ""}`} role="region" aria-label="Update available">
          <p className="flex items-center gap-2 text-body font-medium text-fg">
            <DownloadIcon className="size-4 text-accent-text" />
            Update available — install?
          </p>
          <p className="text-callout text-fg-3">
            Version {release.version}
            {release.hermes?.base_version ? ` · Hermes ${release.hermes.base_version}` : ""} · {mb(release.package.bytes)}. A backup is made first, and {assistant} restarts.
          </p>
          {release.notes && !compact ? <p className="whitespace-pre-wrap text-callout text-fg-2">{release.notes}</p> : null}
          <Row>
            <Button disabled={acting} onClick={() => void act(async () => (await install(false), api.state()))}>
              Install
            </Button>
            <Button subtle disabled={acting} onClick={() => onLater?.()}>
              Later
            </Button>
            <Button subtle disabled={acting} onClick={() => void act(() => api.skip(release.version))}>
              Skip this version
            </Button>
          </Row>
        </div>
      );
    }
  }
}

/** `github:owner/repo` or a github.com URL: a private release repository read with a key. */
export const isGithubFeed = (feed: string) => /^(github:|https:\/\/github\.com\/)[\w-]+\/[\w.-]+/.test(feed.trim());

/** Settings → Updates: where updates come from (a release folder, or a private GitHub release repository and its key), and the card. */
export function UpdatesPanel() {
  const { api } = useUpdates();
  const [feed, setFeed] = useState("");
  const [saved, setSaved] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState("");
  useEffect(() => {
    void api?.feed().then((f) => {
      setFeed(f);
      setSaved(f);
    });
    void api?.hasKey?.().then(setHasKey);
  }, [api]);
  if (!api) return null;
  const github = isGithubFeed(saved);
  return (
    <div className="space-y-3">
      <UpdateCard />
      <div className="text-callout text-fg-2">
        <label htmlFor="update-feed">Update source</label>
        <div className="mt-1.5 flex gap-2">
          <input
            id="update-feed"
            value={feed}
            onChange={(e) => setFeed(e.target.value)}
            spellCheck={false}
            placeholder="github:owner/releases-repo, or a release folder"
            className="min-h-11 min-w-0 flex-1 rounded-ctl border border-line-2 bg-canvas px-3 py-2 font-mono text-code text-fg outline-none placeholder:text-fg-3 focus:border-line-3"
          />
          {feed.trim() !== saved ? (
            <Button
              onClick={async () => {
                await api.setFeed(feed.trim());
                setSaved(feed.trim());
              }}
            >
              Save
            </Button>
          ) : null}
        </div>
        <p className="mt-1 text-caption text-fg-3">Only releases signed by this app&apos;s publisher are offered, and nothing installs without your click.</p>
      </div>
      {github && api.setKey ? (
        <div className="text-callout text-fg-2">
          <label htmlFor="update-key">Update key</label>
          <div className="mt-1.5 flex gap-2">
            <input
              id="update-key"
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              spellCheck={false}
              placeholder={hasKey ? "A key is saved; paste a new one to replace it" : "Paste the key you were given"}
              className="min-h-11 min-w-0 flex-1 rounded-ctl border border-line-2 bg-canvas px-3 py-2 font-mono text-code text-fg outline-none placeholder:text-fg-3 focus:border-line-3"
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
            {hasKey ? "Saved and protected by Windows for your account. " : ""}It only lets this app read new releases; ask whoever gave it to you when it expires.
          </p>
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
