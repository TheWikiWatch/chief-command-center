import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { app, dialog, ipcMain, safeStorage, shell } from "electron";

import { createDiagnostics } from "./diagnostics";
import { bridgeHealth, profileHome } from "./gateway";
import { BOOT_URL, dialogOptions, fileFilters, originOf, senderAllowed, validFeed, validServePort, validThemeMode } from "./guards";
import { type Confirm, confirmFeed, confirmForcedRestart, confirmInstall, confirmPhoneAccess, confirmPhoneEnable, confirmRestore, confirmRollback, skipAllowed } from "./owner-confirm";
import { disablePhone, enablePhone, OPENABLE, phoneState, setPhoneAccess } from "./phone";
import { RELEASE_KEYS } from "./release-key";
import { syncGithubHistory } from "./release-history";
import { effectiveFeed, parseGithub } from "./release-source";
import { applyRestore } from "./restore";
import { dashboardHeaders, engine, hermesVersion } from "./runtime";
import { readUpdateKey, saveUpdateKey } from "./secrets";
import { ctx, log, uiOrigin, uiUrl } from "./state";
import type { Supervisor } from "./supervisor";
import type { UpdateState } from "./updater";
import { applyThemeMode, currentWork } from "./window";

/* What the dashboard (and the boot page) may ask of the shell. */

/**
 * Every IPC channel goes through here: the call must come from this app's window, from a frame showing the
 * dashboard (or the boot page, for boot channels), and the handler validates its own arguments.
 */
function handle(channel: string, fn: (...args: unknown[]) => unknown, opts: { boot?: boolean } = {}) {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    const fromWindow = !!ctx.window && event.sender === ctx.window.webContents;
    if (!fromWindow || !senderAllowed(event.senderFrame?.url, uiOrigin(), BOOT_URL, opts)) {
      log.warn("ipc.refused", { channel, from: originOf(event.senderFrame?.url || "") || "an unknown frame" });
      throw new Error("Not allowed.");
    }
    return fn(...args);
  });
}

/**
 * The shell's own dialog for an action a page could otherwise start alone (owner-confirm.ts). Resolves true only when
 * the owner pressed the button that goes ahead; Escape, closing it or Cancel is a no.
 */
async function ownerConfirms(c: Confirm, channel: string): Promise<boolean> {
  if (!ctx.window) return false;
  const choice = await dialog.showMessageBox(ctx.window, { type: "question", message: c.message, detail: c.detail, buttons: [c.ok, "Cancel"], defaultId: 1, cancelId: 1, noLink: true });
  const yes = choice.response === 0;
  log.info("owner.confirm", { channel, yes });
  return yes;
}

/** What a cancelled update action returns: the state as it was, marked so the page doesn't report progress. */
const cancelled = (state: UpdateState) => ({ ...state, cancelled: true as const });

/** Fetch and verify any published release this install hasn't kept yet (GitHub feeds; a folder feed is kept as it is checked). */
export async function syncHistory(): Promise<{ ok: boolean; added?: number; error?: string }> {
  const repo = parseGithub(effectiveFeed(ctx.store.value.updateFeed, ctx.shippedFeed));
  const key = readUpdateKey(ctx.paths.secrets, safeStorage);
  if (!repo) return { ok: true, added: 0 };
  try {
    return { ok: true, added: await syncGithubHistory(repo.owner, repo.repo, key, ctx.paths.appDir, RELEASE_KEYS) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A check, then, when the owner allows it (Settings → Updates, on by default), the background prepare of the release it
 * found: download, backup and staging run while Chief works, so the update card can offer "Restart". Resolves with
 * the check's state; the prepare reports through the state events.
 */
export async function checkForUpdates(): Promise<UpdateState> {
  const state = await ctx.updater.check();
  if (state.status === "available" && ctx.store.value.prepareUpdates) void ctx.updater.prepare();
  return state;
}

/** Chief's engine and the dashboard server, as the page's banner shows them ("restarting", "retrying in 9 min"). */
export type EngineState = { gateway: Part; web: Part; external: boolean };
type Part = { state: Supervisor["state"]; detail: string; retryInMs: number };

export function engineState(): EngineState {
  const part = (s: Supervisor): Part => ({ state: s.state, detail: s.detail, retryInMs: s.nextAttemptAt ? Math.max(0, s.nextAttemptAt - Date.now()) : 0 });
  return { gateway: part(ctx.gateway), web: part(ctx.web), external: ctx.externalGateway };
}

export function sendEngineState() {
  ctx.window?.webContents.send("desktop:engine", engineState());
}

const diagnosticsName = () => `chief-diagnostics-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.zip`;

async function makeDiagnostics(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const choice = await dialog.showSaveDialog(ctx.window!, {
    title: "Save diagnostics",
    defaultPath: path.join(app.getPath("downloads"), diagnosticsName()),
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (choice.canceled || !choice.filePath) return { ok: false, error: "cancelled" };
  return buildDiagnostics(choice.filePath);
}

/** Report a problem: the diagnostics go straight to Downloads and Explorer opens on them, ready to attach. */
async function reportDiagnostics(): Promise<{ ok: boolean; path?: string; name?: string; error?: string }> {
  const out = path.join(app.getPath("downloads"), diagnosticsName());
  const result = await buildDiagnostics(out);
  return result.ok ? { ...result, name: path.basename(out) } : result;
}

/** Crash dumps on this PC (the app's own; nothing is uploaded). */
function crashDumps(): { dir: string; prefix: string; pattern: RegExp; text: boolean }[] {
  const dirs = [app.getPath("crashDumps"), path.join(app.getPath("crashDumps"), "reports")];
  const any = dirs.some((d) => {
    try {
      return readdirSync(d).some((n) => n.endsWith(".dmp"));
    } catch {
      return false;
    }
  });
  return any ? dirs.map((dir) => ({ dir, prefix: "crashes", pattern: /\.dmp$/, text: false })) : [];
}

async function buildDiagnostics(out: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  // A crash dump is a copy of the app's memory (it can hold parts of conversations and keys), so it goes in only when
  // the owner says so; logs are redacted and always go.
  let dumps = crashDumps();
  if (dumps.length && ctx.window) {
    const choice = await dialog.showMessageBox(ctx.window, {
      type: "question",
      message: "Include crash reports?",
      detail: "The app crashed at some point and kept a report. It helps find the cause, but it's a copy of the app's memory at that moment and can hold parts of conversations or keys. Include it only if you're sending this to someone you trust.",
      buttons: ["Leave them out", "Include them"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (choice.response !== 1) dumps = [];
  } else dumps = [];
  const result = await createDiagnostics({
    out,
    redact: (text) => log.redact(text),
    sources: [
      { dir: ctx.paths.logs, prefix: "logs", pattern: /\.(log|jsonl)(\.\d+)?$/, text: true },
      { dir: path.join(profileHome(ctx.hermesRoot), "logs"), prefix: "bridge", pattern: /^chief-bridge\.log(\.\d+)?$/, text: true },
      ...dumps,
    ],
    info: {
      app: app.getVersion(),
      hermes: hermesVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      os: `${process.platform} ${process.getSystemVersion()}`,
      packaged: app.isPackaged,
      ports: ctx.store.value.ports,
      engine: engineState(),
      adopted: !!ctx.store.value.adopted,
      createdAt: new Date().toISOString(),
    },
  });
  log.info("diagnostics.created", { ok: result.ok, files: result.files?.length, error: result.error });
  if (result.ok) shell.showItemInFolder(out);
  return result.ok ? { ok: true, path: out } : { ok: false, error: result.error };
}

export function registerIpc(boot: { run: () => Promise<unknown> }) {
  const { updater } = ctx;
  handle("updates:state", () => updater.state);
  handle("updates:check", () => checkForUpdates());
  handle("updates:prepare", () => updater.prepare());
  handle("updates:restart", async (force) => {
    if (force === true) {
      const ask = confirmForcedRestart((await currentWork()).reasons);
      if (ask && !(await ownerConfirms(ask, "updates:restart"))) return cancelled(updater.state);
    }
    return updater.restart(force === true);
  });
  handle("updates:options", () => ({ prepare: ctx.store.value.prepareUpdates, early: ctx.store.value.earlyUpdates }));
  handle("updates:setOptions", (options) => {
    const o = (options && typeof options === "object" ? options : {}) as { prepare?: unknown; early?: unknown };
    ctx.store.save({
      ...(typeof o.prepare === "boolean" ? { prepareUpdates: o.prepare } : {}),
      ...(typeof o.early === "boolean" ? { earlyUpdates: o.early } : {}),
    });
    return checkForUpdates();
  });
  handle("updates:skip", (version) => {
    const v = String(version ?? "").trim();
    const offered = updater.state.status === "available" ? updater.state.release.version : null;
    if (skipAllowed(v, offered)) ctx.store.save({ skippedVersions: [...new Set([...ctx.store.value.skippedVersions, v])] });
    return updater.check();
  });
  handle("updates:feed", () => effectiveFeed(ctx.store.value.updateFeed, ctx.shippedFeed));
  handle("updates:hasKey", () => readUpdateKey(ctx.paths.secrets, safeStorage) !== "");
  // A saved key GitHub refused while the repository answered without it: Settings offers to remove it.
  handle("updates:keyStatus", () => ({ saved: readUpdateKey(ctx.paths.secrets, safeStorage) !== "", refused: !!ctx.updateSource?.keyRefused?.() }));
  handle("updates:installVersion", async (version) => {
    const v = String(version ?? "").trim();
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error("Not a version.");
    if (v !== app.getVersion() && !(await ownerConfirms(confirmInstall(v, app.getVersion()), "updates:installVersion"))) return cancelled(updater.state);
    log.info("update.version-chosen", { version: v });
    return updater.installVersion(v);
  });
  handle("updates:setKey", (key) => {
    const k = String(key ?? "").trim().slice(0, 400);
    log.addSecret(k);
    saveUpdateKey(ctx.paths.secrets, safeStorage, k);
    return updater.check();
  });
  handle("updates:setFeed", async (folder) => {
    const feed = validFeed(folder);
    if (feed === null) throw new Error("Use a GitHub repository (github:owner/repo) or a folder on this PC. Network shares aren't allowed.");
    const ask = confirmFeed(feed, ctx.store.value.updateFeed);
    if (ask && !(await ownerConfirms(ask, "updates:setFeed"))) return cancelled(updater.state);
    ctx.store.save({ updateFeed: feed });
    return updater.check();
  });
  handle("updates:history", () => syncHistory());
  handle("updates:rollbackOptions", () => updater.rollbackOptions());
  handle("updates:rollback", async (version) => {
    const v = String(version ?? "");
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error("Not a version.");
    if (!(await ownerConfirms(confirmRollback(v, app.getVersion()), "updates:rollback"))) return cancelled(updater.state);
    log.info("update.rollback-requested", { version: v });
    return updater.rollback(v);
  });
  handle("phone:state", () => phoneState());
  handle("phone:enable", async (port) => {
    const p = validServePort(port);
    if (!(await ownerConfirms(confirmPhoneEnable(), "phone:enable"))) return { ok: false, cancelled: true, error: "" };
    return enablePhone(p);
  });
  handle("phone:disable", () => disablePhone());
  handle("phone:setAccess", async (mode) => {
    const m = mode === "owner" ? "owner" : "tailnet";
    const ask = confirmPhoneAccess(m);
    if (ask && !(await ownerConfirms(ask, "phone:setAccess"))) return { ok: false, cancelled: true, error: "" };
    return setPhoneAccess(m);
  });
  handle("phone:open", (url) => (OPENABLE.test(String(url)) ? shell.openExternal(String(url)).then(() => true) : false));
  handle("boot:retry", () => boot.run(), { boot: true });
  handle("boot:logs", () => shell.openPath(ctx.paths.logs), { boot: true });
  // The boot page's "Go back to X.Y.Z" (offered only after this version failed to start twice): Chief is down anyway.
  handle(
    "boot:rollback",
    () => {
      if (!ctx.rollbackOffer) return { status: "error", error: "Nothing to go back to." };
      log.info("update.rollback-from-boot", { version: ctx.rollbackOffer });
      return updater.rollback(ctx.rollbackOffer, true);
    },
    { boot: true },
  );
  handle("desktop:openLogs", () => shell.openPath(ctx.paths.logs));
  // The app's look changed (or the page loaded with one): the window follows, and remembers it for the next start.
  handle("desktop:setThemeMode", (mode: unknown) => {
    if (!validThemeMode(mode)) return false;
    applyThemeMode(mode);
    if (ctx.store.value.themeMode !== mode) ctx.store.save({ themeMode: mode });
    return true;
  });
  // Settings → About: the third-party notices shipped in the package (empty string when this build has none).
  handle("desktop:openNotices", async () => (existsSync(ctx.paths.notices) ? shell.openPath(ctx.paths.notices) : "missing"));
  handle("desktop:diagnostics", () => makeDiagnostics());
  handle("desktop:reportDiagnostics", () => reportDiagnostics());
  handle("desktop:engine", () => engineState());
  // The banner's "Try now": start Chief (and the dashboard server) again at once.
  handle("desktop:retryChief", async () => {
    log.info("gateway.retry-requested");
    if (!ctx.externalGateway) await ctx.gateway.start();
    await ctx.web.start();
    return engineState();
  });
  // The dashboard asks once its shell has mounted: an action from the launch that started the app.
  handle("desktop:takeAction", () => {
    const action = ctx.pendingAction;
    ctx.pendingAction = null;
    return action;
  });
  handle("desktop:pickFolder", async (opts) => {
    const o = dialogOptions(opts);
    const res = await dialog.showOpenDialog(ctx.window!, { title: o.title, defaultPath: o.defaultPath, properties: ["openDirectory", "createDirectory"] });
    return res.canceled ? null : res.filePaths[0] || null;
  });
  handle("desktop:pickFile", async (opts) => {
    const o = dialogOptions(opts);
    const filters = fileFilters((opts as { filters?: unknown } | undefined)?.filters);
    const res = await dialog.showOpenDialog(ctx.window!, { title: o.title, filters, properties: ["openFile"] });
    return res.canceled ? null : res.filePaths[0] || null;
  });
  handle("desktop:applyRestore", async () => {
    const work = await currentWork();
    if (!(await ownerConfirms(confirmRestore(work.busy ? work.reasons : []), "desktop:applyRestore"))) return { ok: false, cancelled: true, error: "Restore cancelled." };
    ctx.notifier?.stop();
    log.info("restore.apply");
    const result = await applyRestore({
      engine: engine(),
      stateDir: path.join(ctx.paths.appDir, "restore"),
      safetyDir: path.join(ctx.paths.appDir, "safety-backups"),
      appVersion: app.getVersion(),
      stopGateway: () => ctx.gateway.stop(true),
      startGateway: () => ctx.gateway.start(),
      gatewayHealthy: async () => ctx.gateway.state === "running" && (await bridgeHealth(ctx.store.value.ports.bridge, ctx.token)).ok,
      finishInDashboard: async () => {
        const res = await fetch(`${uiUrl()}/api/backup/restore/finish`, { method: "POST", headers: { "Content-Type": "application/json", ...dashboardHeaders() }, body: "{}" });
        return (await res.json()) as { ok: boolean; error?: string };
      },
    });
    log.info("restore.done", { ok: result.ok, error: (result as { error?: string }).error });
    ctx.notifier?.start();
    return result;
  });
}
