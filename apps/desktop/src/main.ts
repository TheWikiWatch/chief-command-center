import { existsSync, readFileSync, rmSync, statfsSync } from "node:fs";
import path from "node:path";

import { app, crashReporter, dialog, protocol, safeStorage, session, utilityProcess } from "electron";

import { createBoot } from "./boot";
import { registerBootScheme, serveBootPage } from "./boot-protocol";
import { payloadLayout } from "./env";
import { bridgeHealth, gatewayOwner, killTree, launchGateway, profileHome, requestScopedStop, waitFor } from "./gateway";
import { actionFromArgv, permissionAllowed, permissionCheckAllowed } from "./guards";
import { installPackage } from "./install-package";
import { registerIpc, sendEngineState, syncHistory } from "./ipc";
import { Notifier } from "./notifier";
import { missing, resolvePaths } from "./paths";
import { isFree, pickPort } from "./ports";
import { cacheRelease, readReleases, recordInstall } from "./release-history";
import { RELEASE_KEYS } from "./release-key";
import { builtInFeed, builtInReportEmail, effectiveFeed, folderSource, githubSource, parseGithub } from "./release-source";
import { agentScriptsDir, engine, envFor, hermesCommit, hermesUpstream, logLine, preUpdateBackup, provisionKey, runPython, toolEnv } from "./runtime";
import { bridgeToken, readUpdateKey } from "./secrets";
import { ctx, hiddenLaunch, log, setStep, STEPS, uiOrigin, uiUrl } from "./state";
import { Store } from "./store";
import { Supervisor, type SupervisorEvent } from "./supervisor";
import { compareVersions, Updater, type Release } from "./updater";
import { launchWeb, webHealth } from "./web";
import { announceUpdate, bringToFront, createTray, createWindow, currentWork, notify, quit, runAction, setJumpList, setSessionCookie, showBootPage, showWindow } from "./window";

/** The data layout this version writes. A later version that changes it raises this, and an older app
 * refuses to open data with a higher number (PLAN §8 "Schema migrations"). */
const DATA_SCHEMA = 1;

/**
 * Chief Command Center's desktop shell (PLAN §4). The only supervisor of the chief's gateway and the
 * dashboard server; the window is a loopback client of the dashboard, exactly like a browser tab.
 *
 * This file wires the parts together at start-up: boot.ts (the start sequence), supervisor.ts (keeping the
 * children running), window.ts (window, tray, quitting), ipc.ts (what the page may ask), phone.ts,
 * install-package.ts and runtime.ts (environments and the bundled Python).
 */

async function choosePorts() {
  const { store, paths, hermesRoot } = ctx;
  const saved = store.value.ports;
  const first = !existsSync(path.join(paths.appDir, "desktop.json"));
  const owner = gatewayOwner(hermesRoot, payloadLayout(paths.payload).launcher);
  let bridge = saved.bridge;
  if (owner.state === "none" && !(await isFree(bridge))) bridge = await pickPort(first ? 7790 : bridge + 1);
  let ui = saved.ui;
  if (!(await isFree(ui))) ui = await pickPort(first ? 3000 : ui + 1, [bridge]);
  if (first || ui !== saved.ui || bridge !== saved.bridge) store.save({ ports: { ui, bridge } });
}

/** Another launcher runs this profile's gateway: take it over (stop only that one), use it as is, or quit. */
async function claimGateway(): Promise<"own" | "external" | "quit"> {
  const { paths, hermesRoot } = ctx;
  const owner = gatewayOwner(hermesRoot, payloadLayout(paths.payload).launcher);
  ctx.externalGateway = false;
  if (owner.state === "ours") killTree(owner.pid); // an orphan from a crashed run of this app
  if (owner.state !== "foreign") return "own";
  const choice = await dialog.showMessageBox(ctx.window!, {
    type: "question",
    title: "Chief is already running",
    message: "Chief is being run by another launcher on this PC.",
    detail: `Take over: this app stops that copy and runs Chief itself (recommended).\nUse it as is: the app connects to the running copy but doesn't manage it.\n\nOther launcher: ${owner.launcher || "unknown"}`,
    buttons: ["Take over", "Use it as is", "Quit"],
    defaultId: 0,
    cancelId: 2,
  });
  if (choice.response === 2) return "quit";
  if (choice.response === 1) {
    ctx.externalGateway = true;
    return "external";
  }
  // Only that gateway, in this profile home (never `hermes gateway stop`; see gateway.ts).
  const layout = payloadLayout(paths.payload);
  requestScopedStop({ python: layout.python, pythonPath: layout.pythonPath, hermesRoot, profile: "chief", env: toolEnv("gateway") }, owner.pid);
  await waitFor(async () => ({ ok: gatewayOwner(hermesRoot, "").state === "none" }), 25_000);
  if (gatewayOwner(hermesRoot, "").state !== "none") killTree(owner.pid);
  return "own";
}

const boot = createBoot({
  setStep,
  showBootPage: () => showBootPage(STEPS.map((s) => ({ ...s }))),
  missing: () => missing(ctx.paths),
  loadToken: () => {
    // The migration hands over an existing install's bridge token once (so phones and scripts stay authorized);
    // it is sealed here and the plain copy removed.
    const handover = path.join(ctx.paths.appDir, "adopt-token.txt");
    const adopt = existsSync(handover) ? readFileSync(handover, "utf8").trim() : "";
    ctx.token = bridgeToken(ctx.paths.secrets, safeStorage, adopt.length >= 32 ? adopt : undefined);
    log.addSecret(ctx.token);
    if (existsSync(handover)) rmSync(handover, { force: true });
    ctx.hermesRoot = ctx.store.value.hermesRoot || path.join(ctx.paths.data, "hermes");
  },
  newerDataError: () =>
    (ctx.store.value.dataSchema || 0) > DATA_SCHEMA
      ? `This data was last opened by a newer version of the app (${ctx.store.value.lastVersion || "unknown"}). Install that version again, or restore the backup made before the update (Settings, then Backup & restore).`
      : null,
  choosePorts,
  restoreJournalExists: () => existsSync(path.join(ctx.paths.appDir, "restore", "restore-journal.json")),
  recover: () => engine()(["recover", "--state-dir", path.join(ctx.paths.appDir, "restore")]) as Promise<{ ok: boolean; action?: string }>,
  provisionKey,
  lastProvisionKey: () => ctx.store.value.provisionKey || "",
  provision: () => {
    // The skills name a Python that stays put across updates (the agent's, in the data folder), not the install's.
    const agent = agentScriptsDir();
    return runPython(
      ctx.paths.provision,
      [
        "--plugins-src", ctx.paths.plugins,
        "--bridge-port", String(ctx.store.value.ports.bridge),
        ...(agent ? ["--agent-python", path.join(agent, "python.exe")] : []),
        ...(ctx.store.value.adopted ? ["--adopted"] : []),
      ],
      {
        ...toolEnv("gateway"),
        HERMES_HOME: profileHome(ctx.hermesRoot),
        PYTHONPATH: payloadLayout(ctx.paths.payload).pythonPath.join(";"),
      },
    );
  },
  saveProvisionKey: (key) => ctx.store.save({ provisionKey: key }),
  // First launch of a new version that brings a different Hermes: a local backup before Hermes starts and
  // migrates anything. An update that keeps the same Hermes build can't migrate the data, so it skips the
  // backup (it is the whole setup, databases included, and takes minutes on a large install).
  backupNeeded: () => {
    const previous = ctx.store.value.lastVersion;
    const hermes = hermesCommit();
    const hermesChanged = !hermes || ctx.store.value.lastHermes !== hermes;
    return previous && compareVersions(app.getVersion(), previous) > 0 && hermesChanged && existsSync(path.join(ctx.hermesRoot, "profiles"))
      ? `Backing up before the first start of ${app.getVersion()}…`
      : null;
  },
  backup: () => preUpdateBackup(),
  recordStart: () => {
    recordInstall(ctx.paths.appDir, app.getVersion(), ctx.store.value.lastVersion);
    ctx.store.save({ lastVersion: app.getVersion(), dataSchema: DATA_SCHEMA, lastHermes: hermesCommit() });
  },
  claimGateway,
  startGateway: () => ctx.gateway.start(),
  gatewayUp: (external) => waitFor(() => bridgeHealth(ctx.store.value.ports.bridge, ctx.token), external ? 10_000 : 1_000),
  gatewayDetail: () => ctx.gateway.detail,
  startWeb: async () => {
    await ctx.web.start();
    return ctx.web.state === "running" ? { ok: true } : { ok: false, detail: ctx.web.detail };
  },
  openDashboard: async () => {
    await setSessionCookie();
    await ctx.window?.loadURL(uiUrl());
    ctx.notifier?.stop();
    ctx.notifier = new Notifier({
      port: () => ctx.store.value.ports.bridge,
      token: ctx.token,
      assistant: () => "Chief",
      shouldNotify: () => !ctx.window || !ctx.window.isVisible() || !ctx.window.isFocused(),
      notify,
    });
    ctx.notifier.start();
    announceUpdate();
    void ctx.updater.check().then(() => syncHistory());
  },
  quit: () => app.exit(0),
  now: () => Date.now(),
  log: (event, fields) => log.info(event, fields),
});

/**
 * A start, counted per version: a version that reaches the dashboard is "healthy". One that fails to start twice
 * (and never did) gets "Go back to X.Y.Z" on the boot page, when that version's package is still on this PC.
 */
async function runBoot() {
  if (boot.running) return boot.run();
  const version = app.getVersion();
  const last = ctx.store.value.bootAttempts;
  const count = last?.version === version ? last.count + 1 : 1;
  ctx.store.save({ bootAttempts: { version, count } });
  const result = await boot.run();
  if (result === "ready") {
    ctx.store.save({ bootAttempts: { version, count: 0 }, healthyVersion: version });
    return result;
  }
  if (result === "error" && count >= 2 && ctx.store.value.healthyVersion !== version) {
    const [previous] = await ctx.updater.rollbackOptions().catch(() => []);
    if (previous) {
      ctx.rollbackOffer = previous.version;
      log.warn("boot.rollback-offered", { from: version, to: previous.version, attempts: count });
      ctx.window?.webContents.send("boot:offer", { rollback: previous.version });
    }
  }
  return result;
}

/** Supervisor events: logged, sent to the page's banner, and a Windows notification when Chief stops for good. */
function onSupervisorEvent(name: "gateway" | "web", e: SupervisorEvent) {
  if (e.type === "state") log.write(e.state === "failed" ? "error" : e.state === "backoff" ? "warn" : "info", `${name}.${e.state}`, e.detail ? { detail: e.detail } : {});
  else {
    const { type, ...fields } = e;
    log.info(`${name}.${type}`, fields);
  }
  if (ctx.quitting) return;
  sendEngineState();
  if (name === "gateway" && e.type === "state" && e.state === "failed") {
    setStep("gateway", "error", `${e.detail} Chief kept stopping; the app tries again every 10 minutes.`);
    if (!ctx.window?.isFocused()) notify("Chief stopped", "It kept stopping, so the app will try again in 10 minutes. Click to open Chief.");
  }
}

/* ------------------------------------------------------------------ start */

registerBootScheme(protocol);
// Crash dumps stay on this PC (the diagnostics bundle collects them); nothing is uploaded.
crashReporter.start({ uploadToServer: false });
process.on("unhandledRejection", (reason) => log.error("process.unhandled-rejection", { reason: reason instanceof Error ? reason : String(reason) }));
process.on("uncaughtException", (error) => log.error("process.uncaught-exception", { error }));

if (!app.requestSingleInstanceLock() || (process.argv.includes("--quit") && !app.isReady())) {
  app.quit();
} else {
  // A second launch shows the window; `--quit` (an installer or updater) asks this instance to quit cleanly.
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--quit")) return void quit();
    const action = actionFromArgv(argv);
    if (action) runAction(action);
    else showWindow();
  });
  ctx.pendingAction = actionFromArgv(process.argv);
  app.setAppUserModelId("org.chiefcommandcenter.desktop");
  app.whenReady().then(async () => {
    ctx.paths = resolvePaths({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath(), env: process.env });
    ctx.store = new Store(ctx.paths.appDir);
    log.info("app.start", { version: app.getVersion(), packaged: app.isPackaged, hidden: hiddenLaunch() });
    serveBootPage(protocol, ctx.paths.staticDir);
    ctx.shippedFeed = builtInFeed(app.getAppPath());
    ctx.reportEmail = builtInReportEmail(app.getAppPath());
    const last = ctx.store.value.lastVersion;
    ctx.updatedFrom = last && compareVersions(app.getVersion(), last) > 0 ? last : "";
    // A graphics process that dies leaves a blank window behind: note it, so an empty window after an update can be told apart.
    app.on("child-process-gone", (_e, d) => {
      if (d.type === "GPU") log.warn("gpu.gone", { reason: d.reason, exitCode: d.exitCode });
    });
    const layout = payloadLayout(ctx.paths.payload);
    ctx.gateway = new Supervisor({
      launch: async () =>
        launchGateway(
          { launcher: layout.launcher, python: layout.python, pythonPath: layout.pythonPath, hermesRoot: ctx.hermesRoot, profile: "chief", env: envFor("gateway"), logFile: path.join(ctx.paths.logs, "gateway.log") },
          (code, pid) => ctx.gateway.exited(code, pid),
        ),
      ready: async () => {
        const up = await waitFor(() => bridgeHealth(ctx.store.value.ports.bridge, ctx.token), 90_000);
        if (!up.ok) throw new Error(up.detail || "Chief didn't answer.");
      },
      health: async () => (await bridgeHealth(ctx.store.value.ports.bridge, ctx.token, 5_000)).ok,
      onEvent: (e) => onSupervisorEvent("gateway", e),
    });
    ctx.web = new Supervisor({
      launch: async () =>
        launchWeb(utilityProcess as never, { serverJs: ctx.paths.webServer, port: ctx.store.value.ports.ui, env: envFor("web"), logFile: path.join(ctx.paths.logs, "dashboard.log") }, (code, pid) => ctx.web.exited(code, pid)),
      ready: async () => {
        const up = await waitFor(() => webHealth(ctx.store.value.ports.ui), 60_000);
        if (!up.ok) throw new Error(up.detail || "The dashboard didn't answer.");
      },
      health: async () => (await webHealth(ctx.store.value.ports.ui, 5_000)).ok,
      onEvent: (e) => onSupervisorEvent("web", e),
    });
    ctx.updater = new Updater({
      source: () => {
        const feed = effectiveFeed(ctx.store.value.updateFeed, ctx.shippedFeed);
        if (!feed) return null;
        const repo = parseGithub(feed);
        return repo ? githubSource(repo.owner, repo.repo, readUpdateKey(ctx.paths.secrets, safeStorage)) : folderSource(feed);
      },
      currentVersion: app.getVersion(),
      publicKey: RELEASE_KEYS,
      // Beside the backups when the owner moved those off a full system drive.
      updatesDir: ctx.store.value.backupDir ? path.join(path.dirname(ctx.store.value.backupDir), "updates") : path.join(ctx.paths.data, "updates"),
      skipped: () => ctx.store.value.skippedVersions,
      freeBytes: async (dir) => {
        const s = statfsSync(existsSync(dir) ? dir : ctx.paths.data);
        return s.bavail * s.bsize;
      },
      activeWork: () => currentWork(),
      // Before installing: the full backup only when the release brings a different upstream Hermes (the only
      // thing that migrates data). The same Hermes with different app patches is caught at first start.
      backup: (release: Release) => (release.hermes?.commit && release.hermes.commit === hermesUpstream() ? Promise.resolve({ ok: true }) : preUpdateBackup()),
      stopChief: async () => {
        ctx.notifier?.stop();
        await ctx.web.stop(true).catch(() => undefined);
        if (!ctx.externalGateway) await ctx.gateway.stop(true).catch(() => undefined);
      },
      startChief: async () => {
        if (!ctx.externalGateway) await ctx.gateway.start();
        await ctx.web.start();
        ctx.notifier?.start();
      },
      install: (file) => installPackage(file),
      history: () => readReleases(ctx.paths.appDir, RELEASE_KEYS),
      onState: (state) => ctx.window?.webContents.send("updates:state", state),
      // Every verified release is kept for the update history (a folder feed's included).
      onVerified: (bytes, signature) => {
        try {
          cacheRelease(ctx.paths.appDir, bytes, signature, RELEASE_KEYS);
        } catch {
          /* the check already reported it */
        }
      },
    });
    setInterval(() => void ctx.updater.check().then(() => syncHistory()), 24 * 3600 * 1000).unref();
    // Default deny (guards.ts): Electron grants every permission unless a handler says otherwise.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      const media = (details as { mediaTypes?: string[] }).mediaTypes || [];
      callback(permissionAllowed(permission, details.requestingUrl || wc.getURL(), uiOrigin(), media));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
      permissionCheckAllowed(permission, requestingOrigin, uiOrigin(), (details as { mediaType?: string }).mediaType),
    );
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: ctx.store.value.startAtLogin, args: ["--hidden"] });
    registerIpc({ run: runBoot });
    createWindow();
    createTray();
    setJumpList();
    if (ctx.updatedFrom && !hiddenLaunch()) {
      logLine("update-install.log", `reopened ${app.getVersion()} (replacing ${ctx.updatedFrom})`);
      bringToFront();
    }
    await runBoot();
  });
  app.on("before-quit", (event) => {
    if (!ctx.quitting) {
      event.preventDefault();
      void quit();
    }
  });
  app.on("window-all-closed", () => {
    /* stays in the tray */
  });
}
