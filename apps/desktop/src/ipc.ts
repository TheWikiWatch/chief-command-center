import { existsSync } from "node:fs";
import path from "node:path";

import { app, dialog, ipcMain, safeStorage, shell } from "electron";

import { createDiagnostics } from "./diagnostics";
import { bridgeHealth, profileHome } from "./gateway";
import { BOOT_URL, dialogOptions, fileFilters, originOf, senderAllowed, validFeed, validServePort } from "./guards";
import { disablePhone, enablePhone, OPENABLE, phoneState, setPhoneAccess } from "./phone";
import { RELEASE_KEYS } from "./release-key";
import { syncGithubHistory } from "./release-history";
import { effectiveFeed, parseGithub } from "./release-source";
import { applyRestore } from "./restore";
import { dashboardHeaders, engine, hermesVersion } from "./runtime";
import { readUpdateKey, saveUpdateKey } from "./secrets";
import { ctx, log, uiOrigin, uiUrl } from "./state";
import type { Supervisor } from "./supervisor";
import { currentWork } from "./window";

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

/** Fetch and verify any published release this install hasn't kept yet (GitHub feeds; a folder feed is kept as it is checked). */
export async function syncHistory(): Promise<{ ok: boolean; added?: number; error?: string }> {
  const repo = parseGithub(effectiveFeed(ctx.store.value.updateFeed, ctx.shippedFeed));
  const key = readUpdateKey(ctx.paths.secrets, safeStorage);
  if (!repo || !key) return { ok: true, added: 0 };
  try {
    return { ok: true, added: await syncGithubHistory(repo.owner, repo.repo, key, ctx.paths.appDir, RELEASE_KEYS) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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

async function makeDiagnostics(): Promise<{ ok: boolean; path?: string; error?: string }> {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const choice = await dialog.showSaveDialog(ctx.window!, {
    title: "Save diagnostics",
    defaultPath: path.join(app.getPath("downloads"), `chief-diagnostics-${stamp}.zip`),
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (choice.canceled || !choice.filePath) return { ok: false, error: "cancelled" };
  const result = createDiagnostics({
    out: choice.filePath,
    redact: (text) => log.redact(text),
    sources: [
      { dir: ctx.paths.logs, prefix: "logs", pattern: /\.(log|jsonl)(\.\d+)?$/, text: true },
      { dir: path.join(profileHome(ctx.hermesRoot), "logs"), prefix: "bridge", pattern: /^chief-bridge\.log(\.\d+)?$/, text: true },
      { dir: app.getPath("crashDumps"), prefix: "crashes", pattern: /\.dmp$/, text: false },
      { dir: path.join(app.getPath("crashDumps"), "reports"), prefix: "crashes", pattern: /\.dmp$/, text: false },
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
  if (result.ok) shell.showItemInFolder(choice.filePath);
  return result.ok ? { ok: true, path: choice.filePath } : { ok: false, error: result.error };
}

export function registerIpc(boot: { run: () => Promise<unknown> }) {
  const { updater } = ctx;
  handle("updates:state", () => updater.state);
  handle("updates:check", () => updater.check());
  handle("updates:download", () => updater.download());
  handle("updates:install", (force) => updater.install(force === true));
  handle("updates:skip", (version) => {
    const v = String(version ?? "").trim();
    if (/^\d+\.\d+\.\d+$/.test(v)) ctx.store.save({ skippedVersions: [...new Set([...ctx.store.value.skippedVersions, v])] });
    return updater.check();
  });
  handle("updates:feed", () => effectiveFeed(ctx.store.value.updateFeed, ctx.shippedFeed));
  handle("updates:hasKey", () => readUpdateKey(ctx.paths.secrets, safeStorage) !== "");
  handle("updates:setKey", (key) => {
    saveUpdateKey(ctx.paths.secrets, safeStorage, String(key ?? "").trim().slice(0, 400));
    return updater.check();
  });
  handle("updates:setFeed", (folder) => {
    const feed = validFeed(folder);
    if (feed === null) throw new Error("Use a GitHub repository (github:owner/repo) or a folder on this PC. Network shares aren't allowed.");
    ctx.store.save({ updateFeed: feed });
    return updater.check();
  });
  handle("updates:history", () => syncHistory());
  handle("updates:rollbackOptions", () => updater.rollbackOptions());
  handle("updates:rollback", (version) => {
    const v = String(version ?? "");
    if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error("Not a version.");
    log.info("update.rollback-requested", { version: v });
    return updater.rollback(v);
  });
  handle("phone:state", () => phoneState());
  handle("phone:enable", (port) => enablePhone(validServePort(port)));
  handle("phone:disable", () => disablePhone());
  handle("phone:setAccess", (mode) => setPhoneAccess(mode === "owner" ? "owner" : "tailnet"));
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
  // Settings → About: the third-party notices shipped in the package (empty string when this build has none).
  handle("desktop:openNotices", async () => (existsSync(ctx.paths.notices) ? shell.openPath(ctx.paths.notices) : "missing"));
  handle("desktop:diagnostics", () => makeDiagnostics());
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
    if (work.busy) {
      const choice = await dialog.showMessageBox(ctx.window!, {
        type: "warning",
        message: "Chief is in the middle of something.",
        detail: `${work.reasons.join("\n")}\n\nRestoring stops Chief now.`,
        buttons: ["Restore anyway", "Cancel"],
        cancelId: 1,
      });
      if (choice.response === 1) return { ok: false, error: "Restore cancelled." };
    }
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
