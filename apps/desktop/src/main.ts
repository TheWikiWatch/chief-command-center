import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, session, shell, Tray, utilityProcess } from "electron";

import { activeWork, fromBridgeSnapshot } from "./active-work";
import { curatedEnv, payloadLayout } from "./env";
import { bridgeHealth, gatewayOwner, killTree, launchGateway, profileHome, waitFor } from "./gateway";
import { Notifier } from "./notifier";
import { missing, resolvePaths, type DesktopPaths } from "./paths";
import { isFree, pickPort } from "./ports";
import { applyRestore, engineRunner } from "./restore";
import { bridgeToken } from "./secrets";
import { Store } from "./store";
import { Supervisor } from "./supervisor";
import { launchWeb, webHealth } from "./web";

/**
 * Chief Command Center's desktop shell (PLAN §4). The only supervisor of the chief's gateway and the
 * dashboard server; the window is a loopback client of the dashboard, exactly like a browser tab.
 */
type Step = { id: string; label: string; state: "waiting" | "working" | "done" | "error"; detail?: string };

let paths: DesktopPaths;
let store: Store;
let token = "";
let hermesRoot = "";
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let gateway: Supervisor;
let web: Supervisor;
let notifier: Notifier | null = null;
let quitting = false;
let externalGateway = false;
let steps: Step[] = [];

const STEPS: Step[] = [
  { id: "runtime", label: "Runtime", state: "waiting" },
  { id: "prepare", label: "Preparing Chief", state: "waiting" },
  { id: "gateway", label: "Chief", state: "waiting" },
  { id: "web", label: "Dashboard", state: "waiting" },
];

function setStep(id: string, state: Step["state"], detail = "") {
  steps = steps.map((s) => (s.id === id ? { ...s, state, detail } : s));
  window?.webContents.send("boot:status", steps);
}

function hiddenLaunch() {
  return process.argv.includes("--hidden");
}

function uiUrl() {
  return `http://127.0.0.1:${store.value.ports.ui}`;
}

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

function hermesVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(path.join(paths.payload, "manifest.json"), "utf8")) as { version?: string; hermes_version?: string };
    return String(manifest.hermes_version || manifest.version || "");
  } catch {
    return "";
  }
}

function envFor(kind: "gateway" | "web"): Record<string, string> {
  const layout = payloadLayout(paths.payload, toolDirs(paths.payload));
  const common = { PYTHONIOENCODING: "utf-8" };
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
      CHIEF_APP_DATA: paths.appDir,
      CHIEF_HERMES_ROOT: hermesRoot,
      CHIEF_PYTHON: layout.python,
      CHIEF_BACKUP_ENGINE: paths.backupEngine,
      CHIEF_APP_VERSION: app.getVersion(),
      CHIEF_HERMES_VERSION: hermesVersion(),
    },
  });
}

function runPython(script: string, args: string[], env: Record<string, string>): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  const python = payloadLayout(paths.payload).python;
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(python, ["-B", script, ...args], { env, windowsHide: true });
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.on("error", () => resolve({ ok: false, error: "The runtime's Python couldn't start." }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split(/\r?\n/).pop() || ""));
      } catch {
        resolve({ ok: false, error: "Preparing Hermes failed." });
      }
    });
  });
}

/* ------------------------------------------------------------------ boot */

async function choosePorts() {
  const saved = store.value.ports;
  const first = !existsSync(path.join(paths.appDir, "desktop.json"));
  const owner = gatewayOwner(hermesRoot, payloadLayout(paths.payload).launcher);
  let bridge = saved.bridge;
  if (owner.state === "none" && !(await isFree(bridge))) bridge = await pickPort(first ? 7790 : bridge + 1);
  let ui = saved.ui;
  if (!(await isFree(ui))) ui = await pickPort(first ? 3000 : ui + 1, [bridge]);
  if (first || ui !== saved.ui || bridge !== saved.bridge) store.save({ ports: { ui, bridge } });
}

async function boot() {
  steps = STEPS.map((s) => ({ ...s }));
  await window?.loadFile(path.join(paths.staticDir, "boot.html"));
  window?.webContents.send("boot:status", steps);

  setStep("runtime", "working");
  const gone = missing(paths);
  if (gone.length) return setStep("runtime", "error", `Missing: ${gone.join("; ")}`);
  try {
    token = bridgeToken(paths.secrets, safeStorage);
  } catch (e) {
    return setStep("runtime", "error", e instanceof Error ? e.message : String(e));
  }
  hermesRoot = store.value.hermesRoot || path.join(paths.data, "hermes");
  setStep("runtime", "done");

  setStep("prepare", "working");
  await choosePorts();
  const engine = engineRunner(payloadLayout(paths.payload).python, paths.backupEngine, envFor("web"));
  const recovered = await engine(["recover", "--state-dir", path.join(paths.appDir, "restore")]);
  if (recovered.ok && recovered.action === "rolled-back") setStep("prepare", "working", "An interrupted restore was undone.");
  const provisioned = await runPython(paths.provision, ["--plugins-src", paths.plugins, "--bridge-port", String(store.value.ports.bridge)], {
    ...envFor("gateway"),
    HERMES_HOME: profileHome(hermesRoot),
    PYTHONPATH: path.join(paths.payload, "hermes-agent"),
  });
  if (!provisioned.ok) return setStep("prepare", "error", provisioned.error || "Preparing Hermes failed.");
  setStep("prepare", "done");

  setStep("gateway", "working");
  const owner = gatewayOwner(hermesRoot, payloadLayout(paths.payload).launcher);
  externalGateway = false;
  if (owner.state === "ours") killTree(owner.pid); // an orphan from a crashed run of this app
  if (owner.state === "foreign") {
    const choice = await dialog.showMessageBox(window!, {
      type: "question",
      title: "Chief is already running",
      message: "Chief is being run by another launcher on this PC.",
      detail: `Take over: this app stops that copy and runs Chief itself (recommended).\nUse it as is: the app connects to the running copy but doesn't manage it.\n\nOther launcher: ${owner.launcher || "unknown"}`,
      buttons: ["Take over", "Use it as is", "Quit"],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice.response === 2) return app.exit(0);
    if (choice.response === 0) {
      spawn(payloadLayout(paths.payload).launcher, ["-p", "chief", "gateway", "stop"], { env: envFor("gateway"), windowsHide: true });
      await waitFor(async () => ({ ok: gatewayOwner(hermesRoot, "").state === "none" }), 25_000);
      if (gatewayOwner(hermesRoot, "").state !== "none") killTree(owner.pid);
    } else externalGateway = true;
  }
  if (!externalGateway) await gateway.start();
  const up = await waitFor(() => bridgeHealth(store.value.ports.bridge, token), externalGateway ? 10_000 : 1_000);
  if (!up.ok) return setStep("gateway", "error", gateway.detail || up.detail || "Chief didn't start.");
  setStep("gateway", "done", up.voice ? "" : "Voice isn't available yet; text chat works.");

  setStep("web", "working");
  await web.start();
  if (web.state !== "running") return setStep("web", "error", web.detail || "The dashboard didn't start.");
  setStep("web", "done");

  await window?.loadURL(uiUrl());
  notifier?.stop();
  notifier = new Notifier({
    port: () => store.value.ports.bridge,
    token,
    assistant: () => "Chief",
    shouldNotify: () => !window || !window.isVisible() || !window.isFocused(),
    notify: (title, body) => {
      const n = new Notification({ title, body, icon: paths.icon });
      n.on("click", showWindow);
      n.show();
    },
  });
  notifier.start();
}

/* ------------------------------------------------------------------ window, tray, quit */

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    show: !hiddenLaunch(),
    backgroundColor: "#0c0d10",
    title: "Chief Command Center",
    icon: paths.icon,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  const origin = () => new URL(uiUrl()).origin;
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith(origin())) void shell.openExternal(url);
    else if (url.startsWith(origin())) return { action: "allow" };
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file:") || url.startsWith(origin())) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  window.webContents.on("render-process-gone", () => window?.webContents.reload());
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window?.hide();
    if (!store.value.closeNoticeShown) {
      store.save({ closeNoticeShown: true });
      new Notification({ title: "Chief keeps running", body: "Chief is still here in the tray. Quit from the tray icon to stop Chief.", icon: paths.icon }).show();
    }
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(paths.icon).resize({ width: 16, height: 16 }));
  tray.setToolTip("Chief Command Center");
  tray.on("click", showWindow);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Chief", click: showWindow },
      { label: "Restart Chief", click: () => void gateway.stop(true).then(() => gateway.start()) },
      { label: "Open logs", click: () => void shell.openPath(paths.logs) },
      { type: "separator" },
      { label: "Quit", click: () => void quit() },
    ]),
  );
}

async function currentWork() {
  try {
    const res = await fetch(`http://127.0.0.1:${store.value.ports.bridge}/snapshot`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    return activeWork(fromBridgeSnapshot(await res.json()));
  } catch {
    return { busy: false, reasons: [] };
  }
}

async function quit() {
  if (quitting) return;
  if (!externalGateway) {
    let work = await currentWork();
    while (work.busy) {
      const choice = await dialog.showMessageBox(window!, {
        type: "warning",
        title: "Chief is busy",
        message: "Chief is in the middle of something.",
        detail: `${work.reasons.join("\n")}\n\nQuitting stops Chief until you open the app again.`,
        buttons: ["Wait for Chief", "Quit now", "Cancel"],
        defaultId: 0,
        cancelId: 2,
      });
      if (choice.response === 2) return;
      if (choice.response === 1) break;
      await waitFor(async () => ({ ok: !(await currentWork()).busy }), 10 * 60_000, 2000);
      work = await currentWork();
    }
  }
  quitting = true;
  notifier?.stop();
  tray?.destroy();
  await web.stop(true).catch(() => undefined);
  if (!externalGateway) await gateway.stop(true).catch(() => undefined);
  app.exit(0);
}

/* ------------------------------------------------------------------ IPC for the dashboard */

function registerIpc() {
  ipcMain.handle("boot:retry", () => boot());
  ipcMain.handle("boot:logs", () => shell.openPath(paths.logs));
  ipcMain.handle("desktop:pickFolder", async (_e, opts: { title?: string; defaultPath?: string } = {}) => {
    const res = await dialog.showOpenDialog(window!, { title: opts.title, defaultPath: opts.defaultPath, properties: ["openDirectory", "createDirectory"] });
    return res.canceled ? null : res.filePaths[0] || null;
  });
  ipcMain.handle("desktop:pickFile", async (_e, opts: { title?: string; filters?: { name: string; extensions: string[] }[] } = {}) => {
    const res = await dialog.showOpenDialog(window!, { title: opts.title, filters: opts.filters, properties: ["openFile"] });
    return res.canceled ? null : res.filePaths[0] || null;
  });
  ipcMain.handle("desktop:applyRestore", async () => {
    const work = await currentWork();
    if (work.busy) {
      const choice = await dialog.showMessageBox(window!, {
        type: "warning",
        message: "Chief is in the middle of something.",
        detail: `${work.reasons.join("\n")}\n\nRestoring stops Chief now.`,
        buttons: ["Restore anyway", "Cancel"],
        cancelId: 1,
      });
      if (choice.response === 1) return { ok: false, error: "Restore cancelled." };
    }
    notifier?.stop();
    const result = await applyRestore({
      engine: engineRunner(payloadLayout(paths.payload).python, paths.backupEngine, envFor("web")),
      stateDir: path.join(paths.appDir, "restore"),
      safetyDir: path.join(paths.appDir, "safety-backups"),
      appVersion: app.getVersion(),
      stopGateway: () => gateway.stop(true),
      startGateway: () => gateway.start(),
      gatewayHealthy: async () => gateway.state === "running" && (await bridgeHealth(store.value.ports.bridge, token)).ok,
      finishInDashboard: async () => {
        const res = await fetch(`${uiUrl()}/api/backup/restore/finish`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: uiUrl(), Host: `127.0.0.1:${store.value.ports.ui}` },
          body: "{}",
        });
        return (await res.json()) as { ok: boolean; error?: string };
      },
    });
    notifier?.start();
    return result;
  });
}

/* ------------------------------------------------------------------ start */

if (!app.requestSingleInstanceLock() || (process.argv.includes("--quit") && !app.isReady())) {
  app.quit();
} else {
  // A second launch shows the window; `--quit` (an installer or updater) asks this instance to quit cleanly.
  app.on("second-instance", (_event, argv) => (argv.includes("--quit") ? void quit() : showWindow()));
  app.setAppUserModelId("org.chiefcommandcenter.desktop");
  app.whenReady().then(async () => {
    paths = resolvePaths({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), env: process.env });
    store = new Store(paths.appDir);
    const layout = payloadLayout(paths.payload);
    gateway = new Supervisor({
      launch: async () => launchGateway({ launcher: layout.launcher, hermesRoot, profile: "chief", env: envFor("gateway"), logFile: path.join(paths.logs, "gateway.log") }, (code, pid) => gateway.exited(code, pid)),
      ready: async () => {
        const up = await waitFor(() => bridgeHealth(store.value.ports.bridge, token), 90_000);
        if (!up.ok) throw new Error(up.detail || "Chief didn't answer.");
      },
      onEvent: (e) => {
        if (e.type === "state" && e.state === "failed") setStep("gateway", "error", `${e.detail} Chief kept stopping, so the app stopped retrying.`);
      },
    });
    web = new Supervisor({
      launch: async () =>
        launchWeb(utilityProcess as never, { serverJs: paths.webServer, port: store.value.ports.ui, env: envFor("web"), logFile: path.join(paths.logs, "dashboard.log") }, (code, pid) => web.exited(code, pid)),
      ready: async () => {
        const up = await waitFor(() => webHealth(store.value.ports.ui), 60_000);
        if (!up.ok) throw new Error(up.detail || "The dashboard didn't answer.");
      },
    });
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
      const ours = wc.getURL().startsWith(uiUrl());
      callback(ours && ["media", "notifications", "clipboard-sanitized-write", "fullscreen"].includes(permission));
    });
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: store.value.startAtLogin, args: ["--hidden"] });
    registerIpc();
    createWindow();
    createTray();
    await boot();
  });
  app.on("before-quit", (event) => {
    if (!quitting) {
      event.preventDefault();
      void quit();
    }
  });
  app.on("window-all-closed", () => {
    /* stays in the tray */
  });
}
