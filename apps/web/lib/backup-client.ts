import { requestJson } from "@/lib/request";

export type BackupParts = "everything" | "setup" | "second-brain";
export type BackupSettings = { folder: string; schedule: "weekly" | "off"; keep: number; parts: BackupParts };
export type BackupJob = {
  kind: "manual" | "auto";
  state: "running" | "done" | "error";
  startedAt: number;
  done: number;
  total: number;
  result?: { path: string; bytes: number; encrypted: boolean; dropped_secrets: string[] };
  error?: string;
};
export type BackupStatus = {
  ok: boolean;
  error?: string;
  setup?: boolean;
  settings: BackupSettings;
  suggestedFolder: string;
  lastBackup: { at: number; path: string; kind: "manual" | "auto"; bytes: number; encrypted: boolean } | null;
  lastError: { at: number; error: string; kind: "manual" | "auto" } | null;
  remind: boolean;
  job: BackupJob | null;
  available: { setup: boolean; secondBrain: boolean };
  secondBrain: string;
  appVersion: string;
};
export type BackupFile = { name: string; path: string; bytes: number; mtime: number; auto: boolean; encrypted: boolean };
export type BackupInfo = {
  ok: boolean;
  error?: string;
  code?: string;
  encrypted: boolean;
  needs_passphrase: boolean;
  compatible?: boolean;
  problem?: string;
  created?: string;
  kind?: string;
  app_version?: string;
  hermes_version?: string;
  parts?: string[];
  secrets_included?: boolean;
  dropped_secrets?: string[];
  summary?: { profiles?: string[]; notes?: number; files?: number; bytes?: number };
  source?: { second_brain?: string };
};

const PREFIX = "/api/backup";
const send = <T>(method: "POST" | "PUT", path: string, body: unknown, timeout = 30_000) =>
  requestJson<T>(`${PREFIX}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeout);

export const backups = {
  status: () => requestJson<BackupStatus>(`${PREFIX}/status`, { cache: "no-store" }, 15_000),
  list: () => requestJson<{ ok: boolean; backups: BackupFile[]; error?: string }>(`${PREFIX}/list`, { cache: "no-store" }, 30_000),
  save: (change: Partial<BackupSettings>) => send<{ ok: boolean; settings?: BackupSettings; error?: string }>("PUT", "settings", change),
  run: (parts: BackupParts, passphrase = "") => send<{ ok: boolean; job?: BackupJob; error?: string }>("POST", "run", { parts, passphrase }),
  inspect: (file: string, passphrase = "") => send<BackupInfo>("POST", "inspect", { file, passphrase }, 10 * 60_000),
  stage: (file: string, parts: string[], passphrase = "", secondBrain = "") =>
    send<{ ok: boolean; error?: string; code?: string; parts?: string[]; files?: number }>("POST", "restore/stage", { file, parts, passphrase, secondBrain }, 6 * 3600_000),
  discard: () => send<{ ok: boolean }>("POST", "restore/discard", {}),
};

export function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function agoLabel(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) {
    const hours = Math.floor((now - at) / 3_600_000);
    return hours <= 0 ? "just now" : `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  return days === 1 ? "yesterday" : `${days} days ago`;
}
