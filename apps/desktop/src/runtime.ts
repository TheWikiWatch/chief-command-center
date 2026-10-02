import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { app } from "electron";

import { curatedEnv, payloadLayout } from "./env";
import { runJsonTool, type ToolResult } from "./python";
import { engineRunner } from "./restore";
import { sessionCookieName } from "./session";
import { ctx, uiUrl } from "./state";

/* The bundled runtime: environments for the children, the payload's install stamp, one-off Python tools. */

function toolDirs(payload: string): string[] {
  const tools = path.join(payload, "tools");
  if (!existsSync(tools)) return [];
  const dirs: string[] = [];
  for (const name of readdirSync(tools)) {
    const dir = path.join(tools, name);
    for (const sub of ["", "bin", "cmd", "Scripts"]) if (existsSync(path.join(dir, sub))) dirs.push(sub ? `${name}\\${sub}` : name);
  }
  return dirs;
}

function stamp(): { baseVersion?: string; displayVersion?: string; upstreamCommit?: string; commit?: string; patches?: string[] } {
  try {
    return JSON.parse(readFileSync(path.join(ctx.paths.payload, "hermes-agent", "install-stamp.json"), "utf8"));
  } catch {
    return {};
  }
}

/** The bundled Hermes, from its install stamp: "2026.9.24 · upstream 41cd311 · 3 app patches" (Settings → About). */
export function hermesVersion(): string {
  const s = stamp();
  const patches = s.patches?.length || 0;
  return [s.baseVersion || s.displayVersion || "", s.upstreamCommit ? `upstream ${s.upstreamCommit.slice(0, 7)}` : "", patches ? `${patches} app patch${patches === 1 ? "" : "es"}` : ""]
    .filter(Boolean)
    .join(" · ");
}

/** The bundled Hermes build (the payload's install stamp): a backup before an update matters only when it changes. */
export function hermesCommit(): string {
  return String(stamp().commit || "");
}

/** The upstream Hermes commit this build bundles (a release manifest's `hermes.commit`). */
export function hermesUpstream(): string {
  return String(stamp().upstreamCommit || "");
}

/** Fleet Health's data folder: an adopted install's own, else beside the Hermes profiles. */
export function learningDir(): string {
  return ctx.store.value.learningDir || path.join(ctx.hermesRoot, "learning");
}

/** Where the app's backups go: the owner's choice (an adopted install keeps them off a full drive), else beside the data. */
export function backupsDir(): string {
  return ctx.store.value.backupDir || path.join(ctx.paths.data, "backups");
}

/**
 * Compiled Python goes to the app's data folder: the installed package is read-only and ships without
 * `__pycache__`, so without this every start would compile Hermes again.
 */
export function pycacheDir(): string {
  return path.join(ctx.paths.data, "pycache");
}

export function envFor(kind: "gateway" | "web"): Record<string, string> {
  const { paths, store, hermesRoot, token, sessionSecret } = ctx;
  const layout = payloadLayout(paths.payload, toolDirs(paths.payload));
  const common = { PYTHONIOENCODING: "utf-8", PYTHONPYCACHEPREFIX: pycacheDir() };
  if (kind === "gateway") {
    return curatedEnv(process.env, {
      payload: layout,
      inheritUserPath: store.value.inheritUserPath,
      set: {
        ...common,
        HERMES_HOME: hermesRoot,
        ...(store.value.sharedGatewayLock ? {} : { HERMES_GATEWAY_LOCK_DIR: paths.locks }),
        HERMES_BIN: layout.launcher,
        CHIEF_DASHBOARD_TOKEN: token,
        CHIEF_DASHBOARD_PORT: String(store.value.ports.bridge),
        CHIEF_LEARNING_DIR: learningDir(),
        ...(store.value.adopted ? { CHIEF_ADOPTED: "1" } : {}),
      },
    });
  }
  return curatedEnv(process.env, {
    payload: layout,
    set: {
      ...common,
      ...store.value.webEnv,
      CHIEF_BRIDGE_URL: `http://127.0.0.1:${store.value.ports.bridge}`,
      CHIEF_DASHBOARD_TOKEN: token,
      CHIEF_SESSION_SECRET: sessionSecret,
      CHIEF_APP_DATA: paths.appDir,
      CHIEF_HERMES_ROOT: hermesRoot,
      CHIEF_PYTHON: layout.python,
      // Fleet Health: the bundled learning ledger (its report folder, the program and the Python that runs it).
      CHIEF_LEARNING_DIR: learningDir(),
      CHIEF_LEARNING_TOOL: store.value.learningTool || path.join(paths.plugins, "chief-dashboard-bridge", "ledger", "learning_ledger.py"),
      CHIEF_HERMES_PYTHON: layout.python,
      CHIEF_PYTHONPATH: layout.pythonPath.join(";"),
      CHIEF_BACKUP_ENGINE: paths.backupEngine,
      CHIEF_APP_VERSION: app.getVersion(),
      CHIEF_HERMES_VERSION: hermesVersion(),
    },
  });
}

/** The same environment for a one-off Python tool (provisioning, the backup engine, a scoped stop), without the
 * bridge token and session secret: none of them talks to the bridge or the dashboard. */
export function toolEnv(kind: "gateway" | "web"): Record<string, string> {
  const { CHIEF_DASHBOARD_TOKEN: _token, CHIEF_SESSION_SECRET: _session, ...rest } = envFor(kind);
  return rest;
}

export function runPython(script: string, args: string[], env: Record<string, string>): Promise<ToolResult> {
  return runJsonTool(payloadLayout(ctx.paths.payload).python, [script, ...args], { env, startError: "The runtime's Python couldn't start.", badAnswer: "Preparing Hermes failed." });
}

/** The backup and restore engine (backup/chief_backup) under the bundled Python. */
export function engine() {
  const layout = payloadLayout(ctx.paths.payload);
  return engineRunner(layout.python, ctx.paths.backupEngine, toolEnv("web"), layout.pythonPath);
}

export function preUpdateBackup(): Promise<{ ok: boolean; error?: string }> {
  return engine()([
    "backup", "--dest", backupsDir(), "--parts", "setup", "--kind", "pre-update", "--local", "--keep", "2",
    "--hermes-root", ctx.hermesRoot, "--app-dir", path.join(ctx.paths.appDir, "settings-backup"), "--app-version", app.getVersion(),
  ]).then((r) => ({ ok: !!r.ok, error: r.error }));
}

/**
 * What provisioning depends on: the app and Hermes builds, the bundled plugins (names, sizes and times, so a dev
 * checkout that edits a plugin re-provisions), the bridge port and adoption. Unchanged, the start skips it.
 */
export function provisionKey(): string {
  const parts = [app.getVersion(), hermesCommit(), String(ctx.store.value.ports.bridge), ctx.store.value.adopted ? "adopted" : "", ctx.hermesRoot];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || !existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (name === "__pycache__" || name === ".token") continue;
      const full = path.join(dir, name);
      const s = statSync(full);
      if (s.isDirectory()) walk(full, depth + 1);
      else parts.push(`${path.relative(ctx.paths.plugins, full)}:${s.size}:${Math.round(s.mtimeMs)}`);
    }
  };
  walk(ctx.paths.plugins, 0);
  let h = 2166136261;
  for (const ch of parts.join("|")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return `${app.getVersion()}:${(h >>> 0).toString(16)}`;
}

/** Fetch with the window's session cookie: the desktop app calling its own dashboard (proxy.ts requires the cookie). */
export function dashboardHeaders(): Record<string, string> {
  return { Origin: uiUrl(), Host: `127.0.0.1:${ctx.store.value.ports.ui}`, Cookie: `${sessionCookieName(ctx.store.value.ports.ui)}=${ctx.sessionSecret}` };
}

/** One line in a plain-text log under logs\ (the installer's log), with a local timestamp like the installer's. */
export function logLine(file: string, text: string) {
  try {
    const d = new Date();
    const at = new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
    mkdirSync(ctx.paths.logs, { recursive: true });
    appendFileSync(path.join(ctx.paths.logs, file), `${at} ${text}\r\n`);
  } catch {
    /* logging never stops the app */
  }
}
