import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The app's own settings, shared by every device (unlike the per-browser preferences in localStorage):
 * `<CHIEF_APP_DATA>/settings.json`. The desktop app sets CHIEF_APP_DATA; a developer sets it in
 * apps/web/.env.local. Written atomically; unknown keys are kept so newer versions can add their own.
 */
export type BackupParts = "everything" | "setup" | "second-brain";
export type BackupSettings = { folder: string; schedule: "weekly" | "off"; keep: number; parts: BackupParts };
export type BackupRecord = { at: number; path: string; kind: "manual" | "auto"; bytes: number; encrypted: boolean; error?: string };
export type AppSettings = {
  backup: BackupSettings;
  lastBackup: BackupRecord | null;
  lastBackupError: { at: number; error: string; kind: "manual" | "auto" } | null;
  [key: string]: unknown;
};

export const DEFAULT_BACKUP: BackupSettings = { folder: "", schedule: "weekly", keep: 4, parts: "everything" };

export function appDataDir(): string {
  const raw = (process.env.CHIEF_APP_DATA || "").trim();
  return raw ? path.resolve(raw) : "";
}

function settingsPath(): string {
  const dir = appDataDir();
  if (!dir) throw new AppDataNotConfigured();
  return path.join(dir, "settings.json");
}

export class AppDataNotConfigured extends Error {
  constructor() {
    super("This install has no app data folder (CHIEF_APP_DATA).");
  }
}

export async function readAppSettings(): Promise<AppSettings> {
  let raw: Partial<AppSettings> = {};
  try {
    raw = JSON.parse(await fs.readFile(settingsPath(), "utf8")) as Partial<AppSettings>;
  } catch (e) {
    if (e instanceof AppDataNotConfigured) throw e;
  }
  const backup = { ...DEFAULT_BACKUP, ...(raw.backup || {}) };
  return { ...raw, backup, lastBackup: raw.lastBackup ?? null, lastBackupError: raw.lastBackupError ?? null };
}

let writing: Promise<unknown> = Promise.resolve();

/** Read-modify-write, one at a time, with an atomic rename. */
export async function updateAppSettings(change: (current: AppSettings) => AppSettings): Promise<AppSettings> {
  const run = writing.then(async () => {
    const next = change(await readAppSettings());
    const file = settingsPath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await fs.rename(tmp, file);
    return next;
  });
  writing = run.catch(() => undefined);
  return run;
}

/** A place to suggest for backups. Shown to the owner; never applied without their choice. */
export function suggestedBackupFolder(): string {
  return path.join(os.homedir(), "Documents", "Chief Backups");
}
