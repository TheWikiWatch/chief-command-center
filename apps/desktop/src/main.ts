import { existsSync, readdirSync, readFileSync, rmSync, statfsSync } from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, session, shell, Tray, utilityProcess } from "electron";

import { activeWork, fromBridgeSnapshot } from "./active-work";
import { curatedEnv, payloadLayout } from "./env";
import { bridgeHealth, gatewayOwner, killTree, launchGateway, profileHome, requestScopedStop, waitFor } from "./gateway";
import { Notifier } from "./notifier";
import { missing, resolvePaths, type DesktopPaths } from "./paths";
import { isFree, pickPort } from "./ports";
import { applyRestore, engineRunner } from "./restore";
import { bridgeToken, readUpdateKey, saveUpdateKey } from "./secrets";
import { Store } from "./store";
import { Supervisor } from "./supervisor";
import { launchWeb, webHealth } from "./web";
import { RELEASE_PUBLIC_KEY } from "./release-key";
import { compareVersions, Updater, type Release } from "./updater";
import { folderSource, githubSource, parseGithub } from "./release-source";

/** The data layout this version writes. A later version that changes it raises this, and an older app
 * refuses to open data with a higher number (PLAN §8 "Schema migrations"). */
const DATA_SCHEMA = 1;

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
let updater: Updater;

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

/** The bundled Hermes, from its install stamp: "2026.9.24 · upstream 41cd311 · 3 app patches" (Settings → About). */
function hermesVersion(): string {
  try {
    const stamp = JSON.parse(readFileSync(path.join(paths.payload, "hermes-agent", "install-stamp.json"), "utf8")) as {
      baseVersion?: string;
      displayVersion?: string;
      upstreamCommit?: string;
      patches?: string[];
    };
    const patches = stamp.patches?.length || 0;
    return [
      stamp.baseVersion || stamp.displayVersion || "",
      stamp.upstreamCommit ? `upstream ${stamp.upstreamCommit.slice(0, 7)}` : "",
      patches ? `${patches} app patch${patches === 1 ? "" : "es"}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  } catch {
    return "";
  }
}

/** The bundled Hermes build (the payload's install stamp): a backup before an update matters only when it changes. */
function hermesCommit(): string {
  try {
    const stamp = JSON.parse(readFileSync(path.join(paths.payload, "hermes-agent", "install-stamp.json"), "utf8")) as { commit?: string };
    return String(stamp.commit || "");
  } catch {
    return "";
  }
}

/** The upstream Hermes commit this build bundles (a release manifest's `hermes.commit`). */
function hermesUpstream(): string {
  try {
    const stamp = JSON.parse(readFileSync(path.join(paths.payload, "hermes-agent", "install-stamp.json"), "utf8")) as { upstreamCommit?: string };
    return String(stamp.upstreamCommit || "");
  } catch {
    return "";
  }
}

/** Fleet Health's data folder: an adopted install's own, else beside the Hermes profiles. */
function learningDir(): string {
  return store.value.learningDir || path.join(hermesRoot, "learning");
}

/** Where the app's backups go: the owner's choice (an adopted install keeps them off a full drive), else beside the data. */
function backupsDir(): string {
  return store.value.backupDir || path.join(paths.data, "backups");
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
    // The migration hands over an existing install's bridge token once (so phones and scripts stay authorized);
    // it is sealed here and the plain copy removed.
    const handover = path.join(paths.appDir, "adopt-token.txt");
    const adopt = existsSync(handover) ? readFileSync(handover, "utf8").trim() : "";
    token = bridgeToken(paths.secrets, safeStorage, adopt.length >= 32 ? adopt : undefined);
    if (existsSync(handover)) rmSync(handover, { force: true });
  } catch (e) {
    return setStep("runtime", "error", e instanceof Error ? e.message : String(e));
  }
  hermesRoot = store.value.hermesRoot || path.join(paths.data, "hermes");
  setStep("runtime", "done");

  setStep("prepare", "working");
  if ((store.value.dataSchema || 0) > DATA_SCHEMA) {
    return setStep(
      "prepare",
      "error",
      `This data was last opened by a newer version of the app (${store.value.lastVersion || "unknown"}). Install that version again, or restore the backup made before the update (Settings, then Backup & restore).`,
    );
  }
  await choosePorts();
  const engine = engineRunner(payloadLayout(paths.payload).python, paths.backupEngine, envFor("web"), payloadLayout(paths.payload).pythonPath);
  const recovered = await engine(["recover", "--state-dir", path.join(paths.appDir, "restore")]);
  if (recovered.ok && recovered.action === "rolled-back") setStep("prepare", "working", "An interrupted restore was undone.");
  const provisioned = await runPython(paths.provision, ["--plugins-src", paths.plugins, "--bridge-port", String(store.value.ports.bridge), ...(store.value.adopted ? ["--adopted"] : [])], {
    ...envFor("gateway"),
    HERMES_HOME: profileHome(hermesRoot),
    PYTHONPATH: payloadLayout(paths.payload).pythonPath.join(";"),
  });
  if (!provisioned.ok) return setStep("prepare", "error", provisioned.error || "Preparing Hermes failed.");
  // First launch of a new version that brings a different Hermes: a local backup before Hermes starts and
  // migrates anything. An update that keeps the same Hermes build can't migrate the data, so it skips the
  // backup (it is the whole setup, databases included, and takes minutes on a large install).
  const previous = store.value.lastVersion;
  const hermes = hermesCommit();
  const hermesChanged = !hermes || store.value.lastHermes !== hermes;
  if (previous && compareVersions(app.getVersion(), previous) > 0 && hermesChanged && existsSync(path.join(hermesRoot, "profiles"))) {
    setStep("prepare", "working", `Backing up before the first start of ${app.getVersion()}…`);
    const saved = await preUpdateBackup();
    if (!saved.ok) return setStep("prepare", "error", `The backup before this version's first start failed: ${saved.error}. Chief wasn't started, so nothing changed.`);
  }
  store.save({ lastVersion: app.getVersion(), dataSchema: DATA_SCHEMA, lastHermes: hermes });
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
      // Only that gateway, in this profile home (never `hermes gateway stop`; see gateway.ts).
      const layout = payloadLayout(paths.payload);
      requestScopedStop({ python: layout.python, pythonPath: layout.pythonPath, hermesRoot, profile: "chief", env: envFor("gateway") }, owner.pid);
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
  void updater.check();
}

function preUpdateBackup(): Promise<{ ok: boolean; error?: string }> {
  const layout = payloadLayout(paths.payload);
  return engineRunner(layout.python, paths.backupEngine, envFor("web"), layout.pythonPath)([
    "backup", "--dest", backupsDir(), "--parts", "setup", "--kind", "pre-update", "--local", "--keep", "2",
    "--hermes-root", hermesRoot, "--app-dir", path.join(paths.appDir, "settings-backup"), "--app-version", app.getVersion(),
  ]).then((r) => ({ ok: !!r.ok, error: r.error }));
}

/** Windows installs the verified package (its signature is checked again by Windows) and relaunches the app. */
function installPackage(file: string): Promise<{ ok: boolean; error?: string }> {
  if (!app.isPackaged) return Promise.resolve({ ok: false, error: "Updates install only in the installed app." });
  const log = path.join(paths.logs, "update-install.log").replace(/'/g, "''");
  const script = [
    `function Note($t) { Add-Content -Path '${log}' -Value ("$(Get-Date -Format s) " + $t) }`,
    `Note 'installing ${path.basename(file).replace(/'/g, "''")}'`,
    "try {",
    `  Add-AppxPackage -Path '${file.replace(/'/g, "''")}' -ForceApplicationShutdown -ForceUpdateFromAnyVersion -ErrorAction Stop`,
    "  Note ('installed ' + (Get-AppxPackage -Name ChiefCommandCenter).Version)",
    "} catch {",
    "  Note ('install failed: ' + $_.Exception.Message)",
    "} finally {",
    // The app always comes back, updated or not, so Chief is never left stopped.
    "  $p = Get-AppxPackage -Name ChiefCommandCenter",
    "  Start-Process ('shell:AppsFolder\\' + $p.PackageFamilyName + '!ChiefCommandCenter')",
    "}",
  ].join("\n");
  // -EncodedCommand (UTF-16LE base64) avoids every command-line quoting pitfall.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // The installer must not be the app's own child: Windows shuts the app's processes down to replace the package
  // (-ForceApplicationShutdown), and a child would be stopped with them halfway through. WMI starts it as a
  // process of its own, outside the app.
  const outer = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}'} | Out-Null`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", outer], { windowsHide: true, timeout: 30_000 });
  if (result.status !== 0) return Promise.resolve({ ok: false, error: "Windows didn't start the installer. Try again." });
  quitting = true;
  setTimeout(() => app.exit(0), 1500);
  return Promise.resolve({ ok: true });
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
  ipcMain.handle("updates:state", () => updater.state);
  ipcMain.handle("updates:check", () => updater.check());
  ipcMain.handle("updates:download", () => updater.download());
  ipcMain.handle("updates:install", (_e, force: boolean) => updater.install(!!force));
  ipcMain.handle("updates:skip", (_e, version: string) => {
    store.save({ skippedVersions: [...new Set([...store.value.skippedVersions, String(version)])] });
    return updater.check();
  });
  ipcMain.handle("updates:feed", () => store.value.updateFeed);
  ipcMain.handle("updates:hasKey", () => readUpdateKey(paths.secrets, safeStorage) !== "");
  ipcMain.handle("updates:setKey", (_e, key: string) => {
    saveUpdateKey(paths.secrets, safeStorage, String(key || ""));
    return updater.check();
  });
  ipcMain.handle("updates:setFeed", (_e, folder: string) => {
    store.save({ updateFeed: String(folder || "").trim() });
    return updater.check();
  });
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
      engine: engineRunner(payloadLayout(paths.payload).python, paths.backupEngine, envFor("web"), payloadLayout(paths.payload).pythonPath),
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
      launch: async () =>
        launchGateway(
          { launcher: layout.launcher, python: layout.python, pythonPath: layout.pythonPath, hermesRoot, profile: "chief", env: envFor("gateway"), logFile: path.join(paths.logs, "gateway.log") },
          (code, pid) => gateway.exited(code, pid),
        ),
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
    updater = new Updater({
      source: () => {
        const feed = store.value.updateFeed.trim();
        if (!feed) return null;
        const repo = parseGithub(feed);
        return repo ? githubSource(repo.owner, repo.repo, readUpdateKey(paths.secrets, safeStorage)) : folderSource(feed);
      },
      currentVersion: app.getVersion(),
      publicKey: RELEASE_PUBLIC_KEY,
      // Beside the backups when the owner moved those off a full system drive.
      updatesDir: store.value.backupDir ? path.join(path.dirname(store.value.backupDir), "updates") : path.join(paths.data, "updates"),
      skipped: () => store.value.skippedVersions,
      freeBytes: async (dir) => {
        const s = statfsSync(existsSync(dir) ? dir : paths.data);
        return s.bavail * s.bsize;
      },
      activeWork: () => currentWork(),
      // Before installing: the full backup only when the release brings a different upstream Hermes (the only
      // thing that migrates data). The same Hermes with different app patches is caught at first start.
      backup: (release: Release) => (release.hermes?.commit && release.hermes.commit === hermesUpstream() ? Promise.resolve({ ok: true }) : preUpdateBackup()),
      stopChief: async () => {
        notifier?.stop();
        await web.stop(true).catch(() => undefined);
        if (!externalGateway) await gateway.stop(true).catch(() => undefined);
      },
      install: (file) => installPackage(file),
      onState: (state) => window?.webContents.send("updates:state", state),
    });
    setInterval(() => void updater.check(), 24 * 3600 * 1000).unref();
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
