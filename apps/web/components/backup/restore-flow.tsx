"use client";

import { useId, useState, type ReactNode } from "react";

import { ArrowLeftIcon, CircleAlertIcon, CircleCheckIcon } from "@/components/icons";
import { backups, sizeLabel, type BackupInfo } from "@/lib/backup-client";
import { desktop } from "@/lib/desktop";
import { useAssistantName } from "@/lib/identity";
import { field } from "@/components/ui/field";

type Stage =
  | { name: "file" }
  | { name: "passphrase"; file: string }
  | { name: "preview"; file: string; passphrase: string; info: BackupInfo }
  | { name: "staged"; file: string; parts: string[] }
  | { name: "done"; report: { remapped: string[]; review: { file: string; line: number; text: string }[]; missing_secrets: string[] } };

const PART_LABEL: Record<string, { title: string; body: string }> = {
  setup: { title: "Setup", body: "Every bot's identity, memory, skills and routines, chat history, settings and connections." },
  "second-brain": { title: "Second Brain", body: "Your notes folder." },
};

/**
 * Restore from a .chiefbackup: choose the file, unlock it if encrypted, preview what's inside, choose parts
 * and where the Second Brain goes, then stage (verified, nothing live changes). The desktop app applies it:
 * it stops Chief, takes a safety backup, swaps, restarts and checks health.
 */
export function RestoreFlow({ initialFile = "", secondBrain = "", onClose }: { initialFile?: string; secondBrain?: string; onClose?: () => void }) {
  const assistant = useAssistantName();
  const [stage, setStage] = useState<Stage>({ name: "file" });
  const [file, setFile] = useState(initialFile);
  const [passphrase, setPassphrase] = useState("");
  const [parts, setParts] = useState<string[]>([]);
  const [brainTarget, setBrainTarget] = useState(secondBrain);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileId = useId();
  const d = desktop();

  async function open(path: string, phrase = "") {
    setBusy(true);
    setError("");
    try {
      const info = await backups.inspect(path, phrase);
      if (!info.ok) {
        if (info.code === "passphrase") setStage({ name: "passphrase", file: path });
        setError(info.error || "That backup couldn't be opened.");
        return;
      }
      if (info.needs_passphrase) {
        setStage({ name: "passphrase", file: path });
        return;
      }
      setParts((info.parts || []).filter((p) => p in PART_LABEL));
      setBrainTarget(secondBrain || info.source?.second_brain || "");
      setStage({ name: "preview", file: path, passphrase: phrase, info });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That backup couldn't be opened.");
    } finally {
      setBusy(false);
    }
  }

  async function prepare(s: Extract<Stage, { name: "preview" }>) {
    setBusy(true);
    setError("");
    try {
      const res = await backups.stage(s.file, parts, s.passphrase, parts.includes("second-brain") ? brainTarget : "");
      if (!res.ok) setError(res.error || "The backup couldn't be prepared.");
      else setStage({ name: "staged", file: s.file, parts });
    } catch (e) {
      setError(e instanceof Error ? e.message : "The backup couldn't be prepared.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!d?.applyRestore) return;
    setBusy(true);
    setError("");
    try {
      const res = await d.applyRestore();
      if (!res.ok || !res.report) setError(res.error || "The restore didn't finish; your previous setup was kept.");
      else setStage({ name: "done", report: res.report });
    } finally {
      setBusy(false);
    }
  }

  if (stage.name === "done") {
    const { report } = stage;
    return (
      <Section title="Restored" onClose={onClose}>
        <Line tone="ok">{assistant} is back with the restored data. A safety backup of the previous state was kept.</Line>
        {report.missing_secrets.length ? (
          <Line tone="warn">
            This backup didn&apos;t include these keys; add them again in Settings: <span className="font-mono text-code">{report.missing_secrets.join(", ")}</span>
          </Line>
        ) : null}
        {report.review.length ? (
          <div className="rounded-card border border-line bg-card px-3 py-2">
            <p className="text-callout text-fg-2">These settings still mention folders from the old PC. Check them:</p>
            <ul className="mt-1 max-h-40 overflow-y-auto font-mono text-code text-fg-3">
              {report.review.map((r) => (
                <li key={`${r.file}:${r.line}`}>
                  {r.file}:{r.line} {r.text}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>
    );
  }

  if (stage.name === "staged") {
    return (
      <Section title="Ready to restore" onClose={onClose}>
        <Line tone="ok">The backup was checked file by file. Nothing has changed yet.</Line>
        <p className="text-callout text-fg-2">
          Restoring stops {assistant}, keeps a safety backup of what&apos;s here now (so this can be undone), puts the backup in place, and starts {assistant} again.
        </p>
        {error ? <Line tone="error">{error}</Line> : null}
        {d?.applyRestore ? (
          <Button busy={busy} onClick={() => void apply()}>
            {busy ? "Restoring…" : `Restore now`}
          </Button>
        ) : (
          <Line tone="warn">Finish in the desktop app: only it can stop {assistant} safely. This browser can prepare the restore but not apply it.</Line>
        )}
        <Button
          subtle
          busy={busy}
          onClick={async () => {
            await backups.discard().catch(() => undefined);
            setStage({ name: "file" });
          }}
        >
          Cancel
        </Button>
      </Section>
    );
  }

  if (stage.name === "preview") {
    const { info } = stage;
    const s = info.summary || {};
    return (
      <Section title="What's in this backup" onBack={() => setStage({ name: "file" })} onClose={onClose}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-callout">
          <dt className="text-fg-3">Made</dt>
          <dd className="text-fg">{info.created ? new Date(info.created).toLocaleString() : "unknown"}</dd>
          <dt className="text-fg-3">App</dt>
          <dd className="text-fg">
            {info.app_version}
            {info.hermes_version ? ` · Hermes ${info.hermes_version}` : ""}
          </dd>
          {s.profiles?.length ? (
            <>
              <dt className="text-fg-3">Bots</dt>
              <dd className="text-fg">{s.profiles.join(", ")}</dd>
            </>
          ) : null}
          {typeof s.notes === "number" && info.parts?.includes("second-brain") ? (
            <>
              <dt className="text-fg-3">Notes</dt>
              <dd className="text-fg">{s.notes.toLocaleString()}</dd>
            </>
          ) : null}
          {s.bytes ? (
            <>
              <dt className="text-fg-3">Size</dt>
              <dd className="text-fg">{sizeLabel(s.bytes)}</dd>
            </>
          ) : null}
        </dl>
        {info.compatible === false ? <Line tone="error">{info.problem}</Line> : null}
        {!info.secrets_included && (info.dropped_secrets || []).length ? (
          <Line tone="warn">This backup wasn&apos;t encrypted, so API keys and sign-ins aren&apos;t in it. Keys already on this PC are kept; others you&apos;ll add again.</Line>
        ) : null}
        {info.compatible !== false ? (
          <>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-callout text-fg-2">Restore</legend>
              {(info.parts || []).filter((p) => p in PART_LABEL).map((p) => (
                <label key={p} className="flex items-start gap-3 rounded-card border border-line px-3 py-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={parts.includes(p)}
                    onChange={(e) => setParts((cur) => (e.target.checked ? [...cur, p] : cur.filter((x) => x !== p)))}
                  />
                  <span>
                    <span className="block text-body text-fg">{PART_LABEL[p].title}</span>
                    <span className="block text-caption text-fg-3">{PART_LABEL[p].body}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {parts.includes("second-brain") ? (
              <label className="block text-callout text-fg-2">
                Put the Second Brain in
                <input
                  value={brainTarget}
                  onChange={(e) => setBrainTarget(e.target.value)}
                  spellCheck={false}
                  className={field({ mono: true, extra: "mt-1.5 w-full py-2" })}
                />
                <span className="mt-1 block text-caption text-fg-3">An empty or new folder, or your current Second Brain (it is backed up first). Nothing is merged.</span>
              </label>
            ) : null}
            {error ? <Line tone="error">{error}</Line> : null}
            <Button busy={busy} disabled={!parts.length || (parts.includes("second-brain") && !brainTarget.trim())} onClick={() => void prepare(stage)}>
              {busy ? "Checking the backup…" : "Continue"}
            </Button>
          </>
        ) : null}
      </Section>
    );
  }

  if (stage.name === "passphrase") {
    return (
      <Section title="This backup is encrypted" onBack={() => setStage({ name: "file" })} onClose={onClose}>
        <label className="block text-callout text-fg-2">
          Passphrase
          <input
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && passphrase) void open(stage.file, passphrase);
            }}
            className={field({ extra: "mt-1.5 w-full py-2" })}
          />
        </label>
        {error ? <Line tone="error">{error}</Line> : null}
        <Button busy={busy} disabled={!passphrase} onClick={() => void open(stage.file, passphrase)}>
          {busy ? "Unlocking…" : "Unlock"}
        </Button>
        <p className="text-caption text-fg-3">A forgotten passphrase can&apos;t be recovered.</p>
      </Section>
    );
  }

  return (
    <Section title="Restore from a backup" onClose={onClose}>
      <div className="text-callout text-fg-2">
        <label htmlFor={fileId}>Backup file</label>
        <div className="mt-1.5 flex gap-2">
          <input
            id={fileId}
            value={file}
            onChange={(e) => setFile(e.target.value)}
            spellCheck={false}
            placeholder="D:\Backups\Chief backup 2026-09-30 101500.chiefbackup"
            className={field({ mono: true, extra: "min-w-0 flex-1 py-2" })}
          />
          {d?.pickFile ? (
            <button
              type="button"
              className="press min-h-11 shrink-0 rounded-full border border-line-2 px-4 text-callout text-fg-2 hover:text-fg"
              onClick={async () => {
                const chosen = await d.pickFile!({ title: "Choose a Chief backup", filters: [{ name: "Chief backup", extensions: ["chiefbackup"] }] }).catch(() => null);
                if (chosen) setFile(chosen);
              }}
            >
              Browse…
            </button>
          ) : null}
        </div>
      </div>
      {error ? <Line tone="error">{error}</Line> : null}
      <Button busy={busy} disabled={!file.trim()} onClick={() => void open(file.trim())}>
        {busy ? "Opening…" : "Open backup"}
      </Button>
    </Section>
  );
}

function Section({ title, onBack, onClose, children }: { title: string; onBack?: () => void; onClose?: () => void; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        {onBack ? (
          <button type="button" aria-label="Back" onClick={onBack} className="press -ml-1 grid size-9 place-items-center rounded-full text-fg-3 hover:bg-fill-2 hover:text-fg">
            <ArrowLeftIcon className="size-4" />
          </button>
        ) : null}
        <h3 className="min-w-0 flex-1 text-headline text-fg">{title}</h3>
        {onClose ? (
          <button type="button" onClick={onClose} className="press min-h-9 rounded-full px-3 text-callout text-fg-3 hover:text-fg-2">
            Close
          </button>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Line({ tone, children }: { tone: "ok" | "warn" | "error"; children: ReactNode }) {
  const Icon = tone === "ok" ? CircleCheckIcon : CircleAlertIcon;
  return (
    <p role={tone === "error" ? "alert" : "status"} className={`flex items-start gap-2 text-callout ${tone === "error" ? "text-danger" : "text-fg-2"}`}>
      <Icon className={`mt-0.5 size-4 shrink-0 ${tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : ""}`} />
      <span>{children}</span>
    </p>
  );
}

function Button({ children, onClick, busy, disabled, subtle }: { children: ReactNode; onClick: () => void; busy?: boolean; disabled?: boolean; subtle?: boolean }) {
  return (
    <button
      type="button"
      disabled={busy || disabled}
      onClick={onClick}
      className={`press min-h-11 w-full rounded-full px-5 text-callout font-semibold disabled:opacity-50 ${subtle ? "border border-line-2 text-fg-2 hover:text-fg" : "bg-fg text-canvas"}`}
    >
      {children}
    </button>
  );
}
