"use client";

import { useCallback, useEffect, useState } from "react";

import { CircleAlertIcon, SparklesIcon, XIcon } from "@/components/icons";
import { desktop } from "@/lib/desktop";
import { showToast } from "@/lib/toast-store";
import { Sheet } from "@/components/ui/sheet";
import { usePhoneShell } from "@/lib/use-phone-shell";
import { loadUpdateHistory, markWhatsNewSeen, shortDate, whatsNewFor, type UpdateHistory } from "@/lib/update-history-client";
import { LAYER } from "@/lib/layers";
import { compareVersions } from "@/lib/versions";

const newerThan = (a: string, b: string) => compareVersions(a, b) > 0;

type Entry = { version: string; published: string; notes: string; hermes: string; highlights?: string[]; installedAt: string; hermesChanged: boolean; known: boolean };

/** "New in Hermes": what a release that moved the built-in Hermes brings, in two or three short lines. */
function HermesHighlights({ hermes, highlights }: { hermes: string; highlights: string[] }) {
  return (
    <div className="mt-2 rounded-ctl bg-fill-1 px-3 py-2">
      <p className="text-caption font-medium text-fg-2">New in Hermes{hermes ? ` ${hermes}` : ""}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-callout text-fg-2 marker:text-fg-4">
        {highlights.map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
    </div>
  );
}

/** Releases newest first, joined with when each first ran here; versions only seen here (no kept notes) included. */
export function historyEntries(history: UpdateHistory): Entry[] {
  const installedAt = new Map<string, string>();
  for (const i of history.installs) if (!installedAt.has(i.version)) installedAt.set(i.version, i.at);
  const byVersion = new Map(history.releases.map((r) => [r.version, r]));
  const versions = [...new Set([...history.releases.map((r) => r.version), ...history.installs.map((i) => i.version)])].sort((a, b) => compareVersions(b, a));
  return versions.map((version, i) => {
    const r = byVersion.get(version);
    const older = versions.slice(i + 1).map((v) => byVersion.get(v)).find(Boolean);
    return {
      version,
      published: r?.published || "",
      notes: r?.notes || "",
      hermes: r?.hermes || "",
      highlights: r?.highlights,
      installedAt: installedAt.get(version) || "",
      hermesChanged: !!(r?.hermes && older?.hermes && r.hermes !== older.hermes),
      known: !!r,
    };
  });
}

/** Settings → Backup & updates → History, and About → Version: every published version and what it changed. */
export function UpdateHistorySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const phone = usePhoneShell();
  const [history, setHistory] = useState<UpdateHistory | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setError("");
    // Kept history at once, then again after any new release was fetched.
    void loadUpdateHistory(false)
      .then((h) => alive && setHistory(h))
      .catch(() => undefined)
      .then(() => loadUpdateHistory(true))
      .then((h) => alive && setHistory(h))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Couldn't read the update history."));
    return () => {
      alive = false;
    };
  }, [open]);
  const entries = history ? historyEntries(history) : [];
  return (
    <Sheet open={open} onClose={onClose} side={phone ? "bottom" : "right"} tall title="Update history" subtitle="Every published version, newest first." zIndex={LAYER.sheetOverSheet}>
      <div className="px-4 pb-8 pt-4">
        {error && !history ? (
          <p role="alert" className="flex items-start gap-2 text-callout text-danger">
            <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        ) : !history ? (
          <p className="text-callout text-fg-3">Reading the history…</p>
        ) : !history.available ? (
          <p className="text-callout text-fg-3">The update history is kept by the installed app. This development build has none.</p>
        ) : !entries.length ? (
          <p className="text-callout text-fg-3">No versions are known yet. They appear after the app checks for updates (Settings → Backup & updates → Check now).</p>
        ) : (
          <ol className="relative space-y-6 border-l border-line pl-5">
            {entries.map((e) => {
              const current = e.version === history.current;
              return (
                <li key={e.version} className="relative">
                  <span
                    aria-hidden="true"
                    className={`absolute left-[-26.5px] top-[7px] size-[11px] rounded-full border-2 ${current ? "border-accent bg-accent" : "border-line-3 bg-raised"}`}
                  />
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <h4 className="font-mono text-body font-medium tabular text-fg">{e.version}</h4>
                    {current ? <span className="rounded-full bg-accent/15 px-2 py-0.5 text-caption font-medium text-accent-text">Current</span> : null}
                    {e.hermesChanged ? <span className="rounded-full bg-fill-2 px-2 py-0.5 text-caption text-fg-2">Hermes {e.hermes}</span> : null}
                  </div>
                  <p className="mt-0.5 text-caption text-fg-3">
                    {[e.published ? `Released ${shortDate(e.published)}` : "", e.installedAt ? `installed here ${shortDate(e.installedAt)}` : ""].filter(Boolean).join(" · ") || " "}
                  </p>
                  {e.highlights?.length ? <HermesHighlights hermes={e.hermes} highlights={e.highlights} /> : null}
                  {e.known && !current ? <InstallThisVersion version={e.version} newer={newerThan(e.version, history.current)} onStarted={onClose} /> : null}
                  {e.notes ? (
                    <p className="mt-1.5 whitespace-pre-wrap text-callout text-fg-2">{e.notes}</p>
                  ) : (
                    <p className="mt-1.5 text-callout text-fg-3">{e.known ? "No notes for this version." : "This version's notes aren't kept on this PC."}</p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {history?.available && entries.length ? (
          <p className="mt-8 text-caption text-fg-3">Every entry comes from a release signed by the app&apos;s publisher, checked before it was kept.</p>
        ) : null}
      </div>
    </Sheet>
  );
}

/**
 * "Install this version": any published version, newer or older, in the desktop app (0.1.32 on). It asks once, then
 * the version gets ready in the background like an update (checked against its signed description, backed up first
 * when it brings a different Hermes) and the update card offers the restart.
 */
function InstallThisVersion({ version, newer, onStarted }: { version: string; newer: boolean; onStarted: () => void }) {
  const install = desktop()?.updates?.installVersion;
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  if (!install) return null;
  const go = async () => {
    setError("");
    const state = await install(version).catch((e: unknown) => ({ status: "error" as const, error: e instanceof Error ? e.message : String(e) }));
    if (state.status === "error") return setError(state.error);
    showToast({ title: `Getting ${version} ready`, body: "The update card says when to restart into it.", tone: "ok", icon: "check" });
    onStarted();
  };
  return (
    <div className="mt-2">
      {asking ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="w-full text-caption text-fg-3">
            {newer ? `Install ${version}?` : `Go back to ${version}? Your setup is backed up first when its Hermes is different.`} It gets ready in the background, then you restart into it.
          </p>
          <button type="button" onClick={() => void go()} className="press min-h-9 rounded-full bg-fg px-3 text-callout font-medium text-canvas">
            {newer ? `Install ${version}` : `Go back to ${version}`}
          </button>
          <button type="button" onClick={() => setAsking(false)} className="press min-h-9 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg">
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setAsking(true)} className="press min-h-9 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg">
          Install this version
        </button>
      )}
      {error ? (
        <p role="alert" className="mt-1.5 text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The small, quiet way in: an icon-and-word pill. */
export function UpdateHistoryButton({ className = "" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`press inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg ${className}`}
      >
        History
      </button>
      <UpdateHistorySheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * After an update: the new version's notes once, on each device, for two weeks. Closing it (or opening the
 * full history) marks it seen. One card at a time: while an update is offered (`newer`) this one stays out of
 * the way, and notes for a version a newer update replaces are dropped, not kept for later.
 */
export function WhatsNewCard({ newer = "" }: { newer?: string }) {
  const [history, setHistory] = useState<UpdateHistory | null>(null);
  const [version, setVersion] = useState("");
  const [full, setFull] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadUpdateHistory(false)
      .then((h) => {
        if (!alive) return;
        setHistory(h);
        setVersion(whatsNewFor(h));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  const close = useCallback(() => {
    markWhatsNewSeen(version);
    setVersion("");
  }, [version]);
  const superseded = !!version && !!newer && newerThan(newer, version);
  useEffect(() => {
    if (superseded) close();
  }, [superseded, close]);
  const release = newer ? undefined : history?.releases.find((r) => r.version === version);
  return (
    <>
      {release ? (
        <section aria-label="What's new" className="rounded-card border border-line-2 bg-raised/95 p-3.5 shadow-e4 backdrop-blur-sm">
          <div className="flex items-start gap-2">
            <SparklesIcon className="mt-0.5 size-4 shrink-0 text-accent-text" />
            <div className="min-w-0 flex-1">
              <p className="text-body font-medium text-fg">Updated to {release.version}</p>
              <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-callout text-fg-2">{release.notes}</p>
              {release.highlights?.length ? <HermesHighlights hermes={release.hermes} highlights={release.highlights} /> : null}
              <button
                type="button"
                onClick={() => {
                  setFull(true);
                  close();
                }}
                className="press mt-2 text-callout font-medium text-accent-text hover:underline"
              >
                All updates
              </button>
            </div>
            <button type="button" onClick={close} aria-label="Close what's new" className="press -mr-1 -mt-1 grid size-9 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-fill-2 hover:text-fg">
              <XIcon size={16} />
            </button>
          </div>
        </section>
      ) : null}
      <UpdateHistorySheet open={full} onClose={() => setFull(false)} />
    </>
  );
}
