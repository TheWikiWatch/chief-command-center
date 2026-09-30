import { promises as fs } from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";

import { validMutationOrigin } from "@/lib/proxy-policy";
import { AppDataNotConfigured, readAppSettings, suggestedBackupFolder, updateAppSettings, type BackupParts } from "@/lib/server/app-settings";
import { currentJob, engineConfig, restoreStateDir, runEngine, startBackup } from "@/lib/server/backup";
import { secondBrain } from "@/lib/server/second-brain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Backup & restore for Settings and onboarding.
 *
 *   GET  status                      settings, last backup, the running job, reminder, what's configured
 *   GET  list                        backups in the chosen folder
 *   PUT  settings                    { folder?, schedule?, keep?, parts? }
 *   POST run                         { parts?, passphrase? }
 *   POST inspect                     { file, passphrase? }
 *   POST restore/stage               { file, passphrase?, parts, secondBrain? }  (verified, nothing live changes)
 *   POST restore/discard             drop a staged restore
 *   POST restore/finish              after the desktop app applied a restore and Chief is healthy
 *
 * Applying a staged restore stops Chief, so only the desktop app does it (lib/desktop.ts).
 */
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const REMIND_MS = 30 * 24 * 3600 * 1000;
const PARTS: BackupParts[] = ["everything", "setup", "second-brain"];

async function body(req: Request): Promise<Record<string, unknown>> {
  return (await req.json().catch(() => ({}))) as Record<string, unknown>;
}

async function writableFolder(folder: string): Promise<string> {
  if (!path.isAbsolute(folder)) return "Use a full folder path, like D:\\Backups.";
  try {
    await fs.mkdir(folder, { recursive: true });
    const probe = path.join(folder, `.chief-write-test-${process.pid}`);
    await fs.writeFile(probe, "");
    await fs.unlink(probe);
    return "";
  } catch {
    return "Chief can't write to that folder. Choose another one.";
  }
}

async function status() {
  const cfg = engineConfig();
  const settings = await readAppSettings();
  const brain = await secondBrain();
  const last = settings.lastBackup;
  return {
    ok: true,
    settings: settings.backup,
    suggestedFolder: suggestedBackupFolder(),
    lastBackup: last,
    lastError: settings.lastBackupError,
    remind: !!settings.backup.folder ? !last || Date.now() - last.at > REMIND_MS : false,
    job: currentJob(),
    available: { setup: !!cfg.hermesRoot, secondBrain: !!brain.path },
    secondBrain: brain.path,
    appVersion: cfg.appVersion,
  };
}

async function handle(req: NextRequest, op: string): Promise<Response> {
  const method = req.method;
  if (method !== "GET" && !validMutationOrigin(req.headers, req.url)) return json({ ok: false, error: "Invalid request origin" }, 403);
  if (method === "GET" && op === "status") return json(await status());
  if (method === "GET" && op === "list") {
    const { backup } = await readAppSettings();
    if (!backup.folder) return json({ ok: true, backups: [] });
    return json(await runEngine(["list", "--dest", backup.folder], { timeoutMs: 30_000 }));
  }
  if (method === "PUT" && op === "settings") {
    const b = await body(req);
    const folder = typeof b.folder === "string" ? b.folder.trim() : undefined;
    if (folder) {
      const problem = await writableFolder(folder);
      if (problem) return json({ ok: false, error: problem }, 400);
    }
    const next = await updateAppSettings((s) => ({
      ...s,
      backup: {
        ...s.backup,
        ...(folder !== undefined ? { folder } : {}),
        ...(b.schedule === "weekly" || b.schedule === "off" ? { schedule: b.schedule } : {}),
        ...(typeof b.keep === "number" && b.keep >= 1 && b.keep <= 52 ? { keep: Math.round(b.keep) } : {}),
        ...(PARTS.includes(b.parts as BackupParts) ? { parts: b.parts as BackupParts } : {}),
      },
    }));
    return json({ ok: true, settings: next.backup });
  }
  if (method === "POST" && op === "run") {
    const b = await body(req);
    try {
      const started = await startBackup({
        kind: "manual",
        parts: PARTS.includes(b.parts as BackupParts) ? (b.parts as BackupParts) : undefined,
        passphrase: typeof b.passphrase === "string" && b.passphrase ? b.passphrase : undefined,
      });
      return json({ ok: true, job: started });
    } catch (e) {
      return json({ ok: false, error: e instanceof Error ? e.message : "The backup didn't start." }, 409);
    }
  }
  if (method === "POST" && op === "inspect") {
    const b = await body(req);
    const file = String(b.file || "").trim();
    if (!file) return json({ ok: false, error: "Choose a backup file." }, 400);
    const cfg = engineConfig();
    const passphrase = typeof b.passphrase === "string" && b.passphrase ? b.passphrase : undefined;
    return json(await runEngine(["inspect", "--file", file, "--app-version", cfg.appVersion], { passphrase, timeoutMs: 10 * 60_000 }));
  }
  if (method === "POST" && op === "restore/stage") {
    const b = await body(req);
    const cfg = engineConfig();
    const file = String(b.file || "").trim();
    const parts = Array.isArray(b.parts) ? b.parts.filter((p): p is string => p === "setup" || p === "second-brain") : [];
    if (!file || !parts.length) return json({ ok: false, error: "Choose a backup and what to restore." }, 400);
    const current = (await secondBrain()).path;
    const target = typeof b.secondBrain === "string" && b.secondBrain.trim() ? b.secondBrain.trim() : current;
    const args = ["stage", "--file", file, "--parts", parts.join(","), "--state-dir", restoreStateDir(), "--app-version", cfg.appVersion];
    if (cfg.hermesRoot) args.push("--hermes-root", cfg.hermesRoot);
    if (cfg.appData) args.push("--app-dir", path.join(cfg.appData, "settings-backup"));
    if (parts.includes("second-brain")) {
      if (!target) return json({ ok: false, error: "Choose where the Second Brain should go." }, 400);
      args.push("--second-brain", target);
    }
    if (current) args.push("--current-second-brain", current);
    const passphrase = typeof b.passphrase === "string" && b.passphrase ? b.passphrase : undefined;
    return json(await runEngine(args, { passphrase, timeoutMs: 6 * 3600 * 1000 }));
  }
  if (method === "POST" && op === "restore/discard") {
    return json(await runEngine(["recover", "--state-dir", restoreStateDir()], { timeoutMs: 10 * 60_000 }));
  }
  if (method === "POST" && op === "restore/finish") {
    const finished = await runEngine(["finish", "--state-dir", restoreStateDir()], { timeoutMs: 10 * 60_000 });
    // Settings from the backup, except where this PC keeps its backups.
    try {
      const restored = JSON.parse(await fs.readFile(path.join(engineConfig().appData, "settings-backup", "settings.json"), "utf8")) as Record<string, unknown>;
      await updateAppSettings((s) => ({ ...s, ...restored, backup: { ...(restored.backup as object), folder: s.backup.folder, ...(s.backup.folder ? {} : { schedule: s.backup.schedule }) } as typeof s.backup, lastBackup: s.lastBackup, lastBackupError: s.lastBackupError }));
    } catch {
      /* the backup had no app settings */
    }
    return json(finished);
  }
  return json({ ok: false, error: "Unsupported operation" }, 404);
}

type Ctx = { params: Promise<{ op: string[] }> };

async function route(req: NextRequest, ctx: Ctx) {
  const { op } = await ctx.params;
  try {
    return await handle(req, op.join("/"));
  } catch (e) {
    if (e instanceof AppDataNotConfigured) return json({ ok: false, error: e.message, setup: true }, 404);
    throw e;
  }
}

export const GET = route;
export const POST = route;
export const PUT = route;

