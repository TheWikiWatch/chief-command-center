"use client";

import { useCallback, useEffect, useId, useState, type ReactNode } from "react";

import { RestoreFlow } from "@/components/backup/restore-flow";
import { CircleAlertIcon, CircleCheckIcon } from "@/components/icons";
import { agoLabel, backups, sizeLabel, type BackupFile, type BackupParts, type BackupStatus } from "@/lib/backup-client";
import { desktop } from "@/lib/desktop";
import { useAssistantName } from "@/lib/identity";

const PARTS: { id: BackupParts; label: string; hint: string }[] = [
  { id: "everything", label: "Everything", hint: "Your setup and your Second Brain" },
  { id: "setup", label: "Setup only", hint: "Bots, memory, skills, routines, chats and settings" },
  { id: "second-brain", label: "Second Brain only", hint: "Your notes folder" },
];

/**
 * Settings → Backup & restore. The owner chooses where backups go (a suggestion is shown, never applied on
 * its own); weekly automatic backups keep the last few and start only once a folder is chosen.
 */
export function BackupPanel() {
  const assistant = useAssistantName();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState("");
  const [folder, setFolder] = useState("");
  const [parts, setParts] = useState<BackupParts>("everything");
  const [encrypt, setEncrypt] = useState(false);
  const [pass1, setPass1] = useState("");
  const [pass2, setPass2] = useState("");
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState<BackupFile[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  const folderId = useId();
  const d = desktop();

  const load = useCallback(async () => {
    try {
      const s = await backups.status();
      if (!s.ok) {
        setError(s.error || "Backups aren't available on this install.");
        return;
      }
      setStatus(s);
      setFolder((f) => f || s.settings.folder);
      setParts((p) => (s.settings.parts ? s.settings.parts : p));
      setError("");
      if (s.settings.folder) {
        const listed = await backups.list().catch(() => null);
        if (listed?.ok) setFiles(listed.backups);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Backups aren't available right now.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running = status?.job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), 800);
    return () => window.clearInterval(timer);
  }, [running, load]);

  async function save(change: Parameters<typeof backups.save>[0]) {
    setSaving(true);
    setError("");
    try {
      const res = await backups.save(change);
      if (!res.ok) setError(res.error || "Couldn't save.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setError("");
    if (encrypt && (pass1.length < 8 || pass1 !== pass2)) {
      setError(pass1.length < 8 ? "Use a passphrase of at least 8 characters." : "The passphrases don't match.");
      return;
    }
    const res = await backups.run(parts, encrypt ? pass1 : "").catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : "" }));
    if (!res.ok) setError(res.error || "The backup didn't start.");
    setPass1("");
    setPass2("");
    await load();
  }

  if (restoring !== null) {
    return <RestoreFlow initialFile={restoring} secondBrain={status?.secondBrain || ""} onClose={() => setRestoring(null)} />;
  }
  if (!status) {
    return error ? <Note tone="warn">{error}</Note> : <p className="text-callout text-fg-3">Loading…</p>;
  }

  const job = status.job;
  const chosen = status.settings.folder;
  const pick = d?.pickFolder;
  return (
    <div className="space-y-4">
      <div>
        {status.lastBackup ? (
          <Note tone={status.remind ? "warn" : "ok"}>
            Last backup: {agoLabel(status.lastBackup.at)} ({sizeLabel(status.lastBackup.bytes)}{status.lastBackup.encrypted ? ", encrypted" : ""})
            {status.remind ? ". It's been a while; back up soon." : ""}
          </Note>
        ) : (
          <Note tone={chosen ? "warn" : "idle"}>{chosen ? "No backups yet." : "Choose where backups go to start backing up."}</Note>
        )}
        {status.lastError ? <Note tone="error">The last {status.lastError.kind === "auto" ? "automatic " : ""}backup failed: {status.lastError.error}</Note> : null}
      </div>

      <div className="text-callout text-fg-2">
        <label htmlFor={folderId}>Backup folder</label>
        <div className="mt-1.5 flex gap-2">
          <input
            id={folderId}
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            spellCheck={false}
            placeholder={status.suggestedFolder}
            className="min-h-11 min-w-0 flex-1 rounded-ctl border border-line-2 bg-canvas px-3 py-2 font-mono text-code text-fg outline-none placeholder:text-fg-3 focus:border-line-3"
          />
          {pick ? (
            <SmallButton
              onClick={async () => {
                const chosenPath = await pick({ title: "Choose where backups go", defaultPath: folder || status.suggestedFolder }).catch(() => null);
                if (chosenPath) setFolder(chosenPath);
              }}
            >
              Browse…
            </SmallButton>
          ) : null}
        </div>
        <span className="mt-1 block text-caption text-fg-3">
          An external drive or a synced folder (OneDrive, Dropbox) keeps backups safe if this PC fails.
          {!folder && status.suggestedFolder ? (
            <>
              {" "}
              <button type="button" className="press underline underline-offset-2 hover:text-fg-2" onClick={() => setFolder(status.suggestedFolder)}>
                Use {status.suggestedFolder}
              </button>
            </>
          ) : null}
        </span>
      </div>
      {folder.trim() !== chosen ? (
        <SmallButton disabled={saving || !folder.trim()} onClick={() => void save({ folder: folder.trim() })}>
          {saving ? "Saving…" : "Save folder"}
        </SmallButton>
      ) : null}

      <div className="flex flex-wrap items-center gap-3 text-callout text-fg-2">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={status.settings.schedule === "weekly"} onChange={(e) => void save({ schedule: e.target.checked ? "weekly" : "off" })} />
          Back up automatically every week
        </label>
        <label className="flex items-center gap-2">
          keep the last
          <select
            value={status.settings.keep}
            onChange={(e) => void save({ keep: Number(e.target.value) })}
            className="min-h-9 rounded-ctl border border-line-2 bg-canvas px-2 text-fg"
          >
            {[2, 3, 4, 6, 8, 12].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {status.settings.schedule === "weekly" && !chosen ? <p className="text-caption text-fg-3">Automatic backups start once a folder is saved.</p> : null}
      <p className="text-caption text-fg-3">Automatic backups aren&apos;t encrypted, so they leave out API keys and sign-ins.</p>

      <fieldset>
        <legend className="mb-1.5 text-callout text-fg-2">What to back up</legend>
        <div className="space-y-1.5">
          {PARTS.map((p) => (
            <label key={p.id} className="flex items-start gap-2.5">
              <input
                type="radio"
                name="backup-parts"
                className="mt-1"
                checked={parts === p.id}
                disabled={(p.id === "second-brain" && !status.available.secondBrain) || (p.id === "setup" && !status.available.setup)}
                onChange={() => {
                  setParts(p.id);
                  void save({ parts: p.id });
                }}
              />
              <span>
                <span className="block text-body text-fg">{p.label}</span>
                <span className="block text-caption text-fg-3">{p.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="rounded-card border border-line px-3 py-2.5">
        <label className="flex items-start gap-2.5 text-body text-fg">
          <input type="checkbox" className="mt-1" checked={encrypt} onChange={(e) => setEncrypt(e.target.checked)} />
          <span>
            Encrypt with a passphrase
            <span className="block text-caption text-fg-3">
              Only encrypted backups include API keys and sign-ins. A forgotten passphrase can&apos;t be recovered, by anyone.
            </span>
          </span>
        </label>
        {encrypt ? (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input type="password" autoComplete="new-password" placeholder="Passphrase" value={pass1} onChange={(e) => setPass1(e.target.value)} className="min-h-11 rounded-ctl border border-line-2 bg-canvas px-3 text-body text-fg outline-none focus:border-line-3" />
            <input type="password" autoComplete="new-password" placeholder="Again" value={pass2} onChange={(e) => setPass2(e.target.value)} className="min-h-11 rounded-ctl border border-line-2 bg-canvas px-3 text-body text-fg outline-none focus:border-line-3" />
          </div>
        ) : null}
      </div>

      {running && job ? (
        <div className="space-y-1.5">
          <p className="text-callout text-fg-2">Backing up… {assistant} keeps working meanwhile.</p>
          <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]" role="progressbar" aria-label="Backup progress" aria-valuemin={0} aria-valuemax={job.total || 1} aria-valuenow={job.done}>
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${job.total ? Math.round((job.done / job.total) * 100) : 5}%` }} />
          </div>
        </div>
      ) : (
        <SmallButton primary disabled={!chosen || saving} onClick={() => void runNow()}>
          Back up now
        </SmallButton>
      )}
      {job?.state === "done" && job.result ? (
        <Note tone="ok">
          Saved {job.result.path.split(/[\\/]/).pop()} ({sizeLabel(job.result.bytes)}).
          {job.result.dropped_secrets.length ? " API keys and sign-ins were left out (not encrypted)." : ""}
        </Note>
      ) : null}
      {error ? <Note tone="error">{error}</Note> : null}

      <div className="border-t border-line pt-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-body text-fg">Restore</p>
          <SmallButton onClick={() => setRestoring("")}>From a file…</SmallButton>
        </div>
        {files.length ? (
          <ul className="mt-2 divide-y divide-line rounded-card border border-line">
            {files.slice(0, 8).map((f) => (
              <li key={f.path} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-callout text-fg">{f.name.replace(/\.chiefbackup$/, "")}</span>
                  <span className="block text-caption text-fg-3">
                    {sizeLabel(f.bytes)}
                    {f.encrypted ? " · encrypted" : ""}
                  </span>
                </span>
                <SmallButton onClick={() => setRestoring(f.path)}>Restore…</SmallButton>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function Note({ tone, children }: { tone: "ok" | "warn" | "error" | "idle"; children: ReactNode }) {
  const Icon = tone === "ok" ? CircleCheckIcon : CircleAlertIcon;
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-2 text-callout ${tone === "error" ? "text-danger" : tone === "idle" ? "text-fg-3" : "text-fg-2"}`}>
      {tone === "idle" ? null : <Icon className={`mt-0.5 size-4 shrink-0 ${tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : ""}`} />}
      <span>{children}</span>
    </p>
  );
}

function SmallButton({ children, onClick, disabled, primary }: { children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`press min-h-10 shrink-0 rounded-full px-4 text-callout font-medium disabled:opacity-50 ${primary ? "bg-fg text-canvas" : "border border-line-2 text-fg-2 hover:text-fg"}`}
    >
      {children}
    </button>
  );
}
