import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { appDataDir, readAppSettings, updateAppSettings, type BackupParts } from "@/lib/server/app-settings";
import { secondBrain } from "@/lib/server/second-brain";

/**
 * Backups through the engine in `backup/chief_backup` (Python; the payload's Python in the app).
 *
 *   CHIEF_PYTHON          Python that runs the engine (the payload's own Python)
 *   CHIEF_PYTHONPATH      extra import paths for it (the payload's site-packages), separated by ;
 *   CHIEF_BACKUP_ENGINE   folder that contains chief_backup/ (default: the repo's backup/)
 *   CHIEF_HERMES_ROOT     the Hermes root to back up (every profile)
 *   CHIEF_APP_VERSION     this app's version (default: apps/web/package.json)
 *   CHIEF_HERMES_VERSION  the pinned Hermes version, recorded in each backup
 *
 * One backup runs at a time. A passphrase goes to the engine on stdin and is never stored or logged.
 * Restoring is staged and verified here; the swap needs Chief stopped, so the desktop app applies it.
 */
export type BackupJob = {
  kind: "manual" | "auto";
  state: "running" | "done" | "error";
  startedAt: number;
  done: number;
  total: number;
  result?: { path: string; bytes: number; encrypted: boolean; dropped_secrets: string[] };
  error?: string;
};

const WEEK_MS = 7 * 24 * 3600 * 1000;
let job: BackupJob | null = null;

export function engineConfig() {
  const env = (name: string) => (process.env[name] || "").trim();
  return {
    python: env("CHIEF_PYTHON") || "python",
    engine: env("CHIEF_BACKUP_ENGINE") || path.resolve(process.cwd(), "..", "..", "backup"),
    hermesRoot: env("CHIEF_HERMES_ROOT"),
    appVersion: env("CHIEF_APP_VERSION") || process.env.npm_package_version || "0.1.0",
    hermesVersion: env("CHIEF_HERMES_VERSION"),
    appData: appDataDir(),
  };
}

export function restoreStateDir(): string {
  return path.join(engineConfig().appData, "restore");
}

export function safetyDir(): string {
  return path.join(engineConfig().appData, "safety-backups");
}

type EngineResult = { ok: boolean; error?: string; code?: string; [key: string]: unknown };

/** Run one engine command; resolves with its JSON answer (errors included), never with a traceback. */
export function runEngine(args: string[], opts: { passphrase?: string; onProgress?: (done: number, total: number) => void; timeoutMs?: number } = {}): Promise<EngineResult> {
  const cfg = engineConfig();
  return new Promise((resolve) => {
    let stdout = "";
    let stderrTail = "";
    const child = spawn(cfg.python, ["-B", "-m", "chief_backup", ...args, ...(opts.passphrase !== undefined ? ["--passphrase-stdin"] : [])], {
      cwd: cfg.engine,
      windowsHide: true,
      env: { ...process.env, PYTHONPATH: [cfg.engine, ...(process.env.CHIEF_PYTHONPATH || "").split(";").filter(Boolean)].join(";"), PYTHONIOENCODING: "utf-8" },
    });
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 6 * 3600 * 1000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      for (const line of (stderrTail + chunk).split(/\r?\n/).slice(0, -1)) {
        try {
          const msg = JSON.parse(line) as { progress?: [number, number] };
          if (msg.progress) opts.onProgress?.(msg.progress[0], msg.progress[1]);
        } catch {
          /* not a progress line */
        }
      }
      stderrTail = (stderrTail + chunk).split(/\r?\n/).pop() || "";
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ok: false, error: "The backup tool couldn't start (Python for backups isn't available)." });
    });
    child.on("close", () => {
      clearTimeout(timer);
      const last = stdout.trim().split(/\r?\n/).pop() || "";
      try {
        resolve(JSON.parse(last) as EngineResult);
      } catch {
        resolve({ ok: false, error: "The backup tool stopped unexpectedly." });
      }
    });
    if (opts.passphrase !== undefined) child.stdin.write(`${opts.passphrase}\n`);
    child.stdin.end();
  });
}

function partsList(parts: BackupParts): string[] {
  return parts === "everything" ? ["setup", "second-brain"] : [parts];
}

export function currentJob(): BackupJob | null {
  return job;
}

/** Start a backup; the caller polls `currentJob()`. */
export async function startBackup({ kind, parts, passphrase }: { kind: "manual" | "auto"; parts?: BackupParts; passphrase?: string }): Promise<BackupJob> {
  if (job?.state === "running") throw new Error("A backup is already running.");
  const cfg = engineConfig();
  const settings = await readAppSettings();
  const folder = settings.backup.folder;
  if (!folder) throw new Error("Choose a backup folder first.");
  const chosen = parts || settings.backup.parts;
  const brain = (await secondBrain()).path;
  const wanted = partsList(chosen).filter((p) => (p === "second-brain" ? !!brain : !!cfg.hermesRoot));
  if (!wanted.length) throw new Error(chosen === "second-brain" ? "There's no Second Brain folder to back up yet." : "Chief's data folder isn't known on this install.");
  const args = ["backup", "--dest", folder, "--parts", wanted.join(","), "--kind", kind, "--app-version", cfg.appVersion];
  if (cfg.hermesRoot && wanted.includes("setup")) args.push("--hermes-root", cfg.hermesRoot);
  if (cfg.appData && wanted.includes("setup")) args.push("--app-dir", path.join(cfg.appData, "settings-backup"));
  if (brain && wanted.includes("second-brain")) args.push("--second-brain", brain);
  if (cfg.hermesVersion) args.push("--hermes-version", cfg.hermesVersion);
  if (kind === "auto") args.push("--keep", String(settings.backup.keep));
  if (cfg.appData && wanted.includes("setup")) await snapshotAppSettings();
  const current: BackupJob = { kind, state: "running", startedAt: Date.now(), done: 0, total: 0 };
  job = current;
  void runEngine(args, {
    passphrase: passphrase ? passphrase : undefined,
    onProgress: (done, total) => {
      current.done = done;
      current.total = total;
    },
  }).then(async (res) => {
    // The record is saved before the job reports done, so "done" always comes with "Last backup".
    if (res.ok) {
      current.result = { path: String(res.path), bytes: Number(res.bytes), encrypted: !!res.encrypted, dropped_secrets: (res.dropped_secrets as string[]) || [] };
      await updateAppSettings((s) => ({
        ...s,
        lastBackup: { at: Date.now(), path: String(res.path), kind, bytes: Number(res.bytes), encrypted: !!res.encrypted },
        lastBackupError: null,
      })).catch(() => undefined);
      current.state = "done";
    } else {
      const error = res.error || "The backup failed.";
      await updateAppSettings((s) => ({ ...s, lastBackupError: { at: Date.now(), error, kind } })).catch(() => undefined);
      current.error = error;
      current.state = "error";
    }
  });
  return current;
}

/**
 * The app's shared settings go into a backup as `app/` (a copy, so the live file is never read mid-write).
 * Per-device preferences stay in each browser.
 */
async function snapshotAppSettings() {
  const cfg = engineConfig();
  const dir = path.join(cfg.appData, "settings-backup");
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.copyFile(path.join(cfg.appData, "settings.json"), path.join(dir, "settings.json"));
  } catch {
    /* no settings yet */
  }
}

/** Weekly automatic backups: only once the owner has chosen a folder. */
export async function scheduledTick(now = Date.now()): Promise<"ran" | "not-due" | "off" | "no-folder" | "busy"> {
  let settings;
  try {
    settings = await readAppSettings();
  } catch {
    return "off";
  }
  if (settings.backup.schedule !== "weekly") return "off";
  if (!settings.backup.folder) return "no-folder";
  if (job?.state === "running") return "busy";
  const last = Math.max(settings.lastBackup?.at || 0, settings.lastBackupError?.kind === "auto" ? settings.lastBackupError.at - WEEK_MS + 6 * 3600 * 1000 : 0);
  if (now - last < WEEK_MS) return "not-due";
  try {
    await startBackup({ kind: "auto" });
    return "ran";
  } catch {
    return "busy";
  }
}

let scheduler: ReturnType<typeof setInterval> | null = null;

export function startScheduler() {
  if (scheduler || !appDataDir()) return;
  const tick = () => void scheduledTick().catch(() => undefined);
  setTimeout(tick, 2 * 60 * 1000);
  scheduler = setInterval(tick, 30 * 60 * 1000);
  scheduler.unref?.();
}
