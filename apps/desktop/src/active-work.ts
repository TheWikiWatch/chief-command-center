import { promises as fs } from "node:fs";
import path from "node:path";

import { processInfo, type ProcessInfo } from "./gateway";

/**
 * Before Quit, a restart into an update or a restore stops Chief (PLAN §4 "Shutdown"): is anything in progress? A
 * reply being written, an approval waiting, a message still queued, a kanban worker running, or a backup the
 * dashboard is making. Pure: callers pass what the bridge reported and whether a backup runs (`backupRunning`).
 */
export type WorkSnapshot = {
  generating?: boolean;
  approval?: unknown;
  outboxQueued?: number;
  workers?: { name: string; working: boolean }[];
  backup?: boolean;
};

export type ActiveWork = { busy: boolean; reasons: string[] };

export function activeWork(snapshot: WorkSnapshot | null, assistant = "Chief"): ActiveWork {
  if (!snapshot) return { busy: false, reasons: [] };
  const reasons: string[] = [];
  if (snapshot.generating) reasons.push(`${assistant} is writing a reply.`);
  if (snapshot.approval) reasons.push(`${assistant} is waiting for your approval.`);
  if ((snapshot.outboxQueued || 0) > 0) reasons.push(`${snapshot.outboxQueued} message${snapshot.outboxQueued === 1 ? " is" : "s are"} still being delivered.`);
  const working = (snapshot.workers || []).filter((w) => w.working).map((w) => w.name);
  if (working.length) reasons.push(`${working.join(", ")} ${working.length === 1 ? "is" : "are"} working on a task.`);
  if (snapshot.backup) reasons.push("A backup is running.");
  return { busy: reasons.length > 0, reasons };
}

/** How long the dashboard trusts a backup's record (apps/web/lib/server/backup.ts, LOCK_MAX_AGE_MS). */
const BACKUP_RECORD_MS = 6 * 3600 * 1000;

/**
 * A backup the dashboard is making (Settings, or the weekly one): its engine is a child of the dashboard server, so
 * restarting or stopping that server ends it. The dashboard keeps the engine's pid in `<app data>\backup-running.json`
 * while it runs (apps/web/lib/server/backup.ts). The same rule as the dashboard's (a record under 6 hours old), and the
 * pid must still be a Python that started by then: Windows reuses pids, and a stale record must not hold anything up.
 */
export async function backupRunning(appDir: string, query: (pid: number) => Promise<ProcessInfo | null> = processInfo, now = Date.now()): Promise<boolean> {
  let record: { pid?: unknown; startedAt?: unknown };
  try {
    record = JSON.parse(await fs.readFile(path.join(appDir, "backup-running.json"), "utf8")) as typeof record;
  } catch {
    return false;
  }
  const pid = Number(record?.pid);
  const startedAt = Number(record?.startedAt);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(startedAt) || now - startedAt >= BACKUP_RECORD_MS) return false;
  const info = await query(pid);
  if (!info || !Number.isFinite(info.startedMs)) return false;
  return ["python.exe", "pythonw.exe"].includes(path.basename(info.path).toLowerCase()) && info.startedMs <= startedAt + 60_000;
}

/** Parse the bridge's /snapshot answer (roster rings come from Hermes's kanban work status). */
export function fromBridgeSnapshot(raw: unknown): WorkSnapshot {
  const s = (raw || {}) as {
    generating?: boolean;
    approval?: unknown;
    roster?: { name?: string; id?: string; ring?: string }[];
  };
  return {
    generating: !!s.generating,
    approval: s.approval || null,
    workers: (s.roster || []).map((p) => ({ name: String(p.name || p.id || "A specialist"), working: p.ring === "working" })),
  };
}
