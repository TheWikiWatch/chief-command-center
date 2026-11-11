import { existsSync, readFileSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { app, crashReporter, dialog, nativeTheme, protocol, safeStorage, screen, session, shell, utilityProcess } from "electron";

import { countedStart, createBoot, recoversBoot } from "./boot";
import { registerBootScheme, serveBootPage } from "./boot-protocol";
import { payloadLayout } from "./env";
import {
  bridgeHealth,
  gatewayOwner,
  installedPlugin,
  isOrphan,
  killTree,
  launchGateway,
  leftoverGateway,
  pidFileWritten,
  pluginDigest,
  processesWhere,
  profileHome,
  requestScopedStop,
  stillTheGateway,
  waitFor,
} from "./gateway";
import { actionFromArgv, lookTheme, navigateDecision, permissionAllowed, permissionCheckAllowed, windowOpenDecision, BOOT_URL } from "./guards";
import { fallbackCommandLine, installScript, launchDetached } from "./install-package";
import { checkForUpdates, registerIpc, sendEngineState, syncHistory } from "./ipc";
import { Notifier } from "./notifier";
import { missing, resolvePaths } from "./paths";
import { ensurePhoneHost, resumeServe } from "./phone";
import { decidePorts, isFree } from "./ports";
import { cacheRelease, readReleases, recordInstall } from "./release-history";
import { RELEASE_KEYS } from "./release-key";
import { builtInFeed, builtInReportEmail, effectiveFeed, folderSource, githubSource, parseGithub } from "./release-source";
import { engine, envFor, hermesCommit, hermesUpstream, logLine, preUpdateBackup, provisionKey, runPython, toolEnv } from "./runtime";
import { bridgeToken, legacyTokenFiles, readUpdateKey, rotateBridgeToken } from "./secrets";
import { assistantName, bootSteps, ctx, hiddenLaunch, log, setStep, uiOrigin, uiUrl } from "./state";
import { Store } from "./store";
import { Supervisor, type SupervisorEvent } from "./supervisor";
import { APP_ID, type ChiefLook, handOff, helperCopy, lookFromPage, markReady, PACKAGE_NAME, readResult, resultFile, resultMessage, runStage, updaterDir } from "./update-helper";
import { compareVersions, Updater, type Release } from "./updater";
import { launchWeb, leftoverDashboards, webHealth } from "./web";
import {
  announceUpdate,
  bootPageShown,
  bringToFront,
  createTray,
  createWindow,
  currentWork,
  notify,
  quit,
  refreshTray,
  relaunchAfterQuit,
  runAction,
  setJumpList,
  setSessionCookie,
  showBootPage,
  showWindow,
  shutdown,
} from "./window";

/** What the update window shows of Chief: its face (PNG), its colour and name, from the page (`window.__chiefLook`). */
let chiefLook: ChiefLook = lookFromPage(null);

async function readChiefLook(): Promise<ChiefLook> {
  const contents = ctx.window?.webContents;
  if (!contents || contents.isDestroyed()) return lookFromPage(null);
  try {
    const look = await Promise.race([
      contents.executeJavaScript("typeof window.__chiefLook === 'function' ? window.__chiefLook() : null", true),
      new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
    ]);
    return lookFromPage(look);
  } catch {
    return lookFromPage(null);
  }
}

/** The data layout this version writes. A later version that changes it raises this, and an older app
 * refuses to open data with a higher number (PLAN §8 "Schema migrations"). */
const DATA_SCHEMA = 1;

/**
 * Chief Command Center's desktop shell (PLAN §4). The only supervisor of the chief's gateway and the
 * dashboard server; the window is a loopback client of the dashboard, exactly like a browser tab.
 *
 * This file wires the parts together at start-up: boot.ts (the start sequence), supervisor.ts (keeping the
 * children running), window.ts (window, tray, quitting), ipc.ts (what the page may ask), phone.ts,
 * update-helper.ts and install-package.ts (restarting into an update), and runtime.ts (environments and the
 * bundled Python).
 */

const alive = (s: Supervisor | undefined) => !!s && (s.state === "running" || s.state === "starting");

async function choosePorts() {
  const { store, paths, hermesRoot } = ctx;
  const saved = store.value.ports;
  const first = !existsSync(path.join(paths.appDir, "desktop.json"));
  const owner = gatewayOwner(hermesRoot, payloadLayout(paths.payload).launcher);
  // A gateway on the bridge port (ours, or another launcher's) keeps it; so does this run's own dashboard server.
  const chosen = await decidePorts({ saved, first, bridgeHeld: owner.state !== "none" || alive(ctx.gateway), uiHeld: alive(ctx.web) });
  if (first || chosen.ui !== saved.ui || chosen.bridge !== saved.bridge) store.save({ ports: chosen });
}

/**
 * What an earlier run of this app left running on this data folder (a forced quit, a crash): its gateway and its
 * dashboard server keep their ports for a while, and this start moved to other ports or took the EADDRINUSE that
 * followed for a crash. Each is ended only when it is surely ours (gateway.ts leftoverGateway, web.ts
 * leftoverDashboards), and Windows is asked only when the pid file names a live orphan or the saved dashboard port is
 * taken, so a normal start costs nothing. Then their ports are given a moment to close.
 */
async function endLeftovers() {
  const { store, paths, hermesRoot } = ctx;
  const { ui, bridge } = store.value.ports;
  const launcher = payloadLayout(paths.payload).launcher;
  const owner = gatewayOwner(hermesRoot, launcher);
  const ended: string[] = [];
  const freeing: number[] = [];
  if (owner.state === "ours" && isOrphan(owner, ctx.gateway)) {
    const [proc] = await processesWhere(`ProcessId = ${owner.pid}`);
    if (leftoverGateway(proc, launcher, pidFileWritten(hermesRoot), !app.isPackaged)) {
      await killTree(owner.pid);
      ended.push(`gateway ${owner.pid}`);
      freeing.push(bridge);
    }
  }
  if (!alive(ctx.web) && !(await isFree(ui))) {
    const servers = leftoverDashboards(await processesWhere("CommandLine LIKE '%node.mojom.NodeService%'"), { exe: process.execPath, userData: app.getPath("userData"), pid: process.pid });
    for (const pid of servers) {
      await killTree(pid);
      ended.push(`dashboard ${pid}`);
    }
    if (servers.length) freeing.push(ui);
  }
  if (!ended.length) return;
  log.info("boot.leftovers-ended", { ended });
  const freed = await waitFor(async () => ({ ok: (await Promise.all(freeing.map((p) => isFree(p)))).every(Boolean) }), 10_000, 250);
  if (!freed.ok) log.warn("boot.leftovers-ports-held", { ports: freeing });
}

/** Another launcher runs this profile's gateway: take it over (stop only that one), use it as is, or quit. */
async function claimGateway(): Promise<"own" | "external" | "quit"> {
  const claim = await decideGateway();
  // The tray offers "Restart" only for a gateway this app runs.
  refreshTray();
  return claim;
}

async function decideGateway(): Promise<"own" | "external" | "quit"> {
  const { paths, hermesRoot } = ctx;
  const owner = gatewayOwner(hermesRoot, payloadLayout(paths.payload).launcher);
  ctx.externalGateway = false;
  // An orphan from a crashed run of this app; never the gateway this run's supervisor is starting or running.
  if (isOrphan(owner, ctx.gateway) && (await stillTheGateway((owner as { pid: number }).pid, hermesRoot))) await killTree((owner as { pid: number }).pid);
  if (owner.state !== "foreign") return "own";
  const name = assistantName();
  const choice = await dialog.showMessageBox(ctx.window!, {
    type: "question",
    title: `${name} is already running`,
    message: `${name} is being run by another launcher on this PC.`,
    detail: `Take over: this app stops that copy and runs ${name} itself (recommended).\nUse it as is: the app connects to the running copy but doesn't manage it.\n\nOther launcher: ${owner.launcher || "unknown"}`,
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
  await requestScopedStop({ python: layout.python, pythonPath: layout.pythonPath, hermesRoot, profile: "chief", env: toolEnv("gateway") }, owner.pid);
  await waitFor(async () => ({ ok: gatewayOwner(hermesRoot, "").state === "none" }), 25_000);
  if (gatewayOwner(hermesRoot, "").state !== "none" && (await stillTheGateway(owner.pid, hermesRoot))) await killTree(owner.pid);
  return "own";
}

const boot = createBoot({
  setStep,
  showBootPage: () => showBootPage(bootSteps()),
  missing: () => missing(ctx.paths),
  loadToken: () => {
    // The migration hands over an existing install's bridge token once (so phones and scripts stay authorized);
    // it is sealed here and the plain copy removed.
    const handover = path.join(ctx.paths.appDir, "adopt-token.txt");
    const adopt = existsSync(handover) ? readFileSync(handover, "utf8").trim() : "";
    ctx.hermesRoot = ctx.store.value.hermesRoot || path.join(ctx.paths.data, "hermes");
    ctx.token = bridgeToken(ctx.paths.secrets, safeStorage, adopt.length >= 32 ? adopt : undefined);
    // A plain-text copy from before the app sealed the token (an adopted install's `.token`) was readable by the agent:
    // remove it and use a new token. Skipped while an adoption is being verified (it still checks with that token).
    const legacy = adopt ? [] : legacyTokenFiles(ctx.hermesRoot);
    if (legacy.length) {
      ctx.token = rotateBridgeToken(ctx.paths.secrets, safeStorage);
      for (const file of legacy) rmSync(file, { force: true });
      log.info("bridge.token.rotated", { removed: legacy.length });
    }
    log.addSecret(ctx.token);
    log.addSecret(readUpdateKey(ctx.paths.secrets, safeStorage));
    if (existsSync(handover)) rmSync(handover, { force: true });
  },
  // The dashboard (and its Settings) can't open on this screen: the way out is the newer version itself.
  newerDataError: () => {
    if ((ctx.store.value.dataSchema || 0) <= DATA_SCHEMA) return null;
    const newer = ctx.store.value.lastVersion;
    return `Your data was last opened by a newer version of the app${newer ? ` (${newer})` : ""}, which this version can't read. Install ${newer || "that version"} or a newer one, and ${assistantName()} opens as before.`;
  },
  endLeftovers: () => endLeftovers().catch((error) => log.warn("boot.leftovers-failed", { error })),
  choosePorts,
  restoreJournalExists: () => existsSync(path.join(ctx.paths.appDir, "restore", "restore-journal.json")),
  recover: () => engine()(["recover", "--state-dir", path.join(ctx.paths.appDir, "restore")]) as Promise<{ ok: boolean; action?: string }>,
  provisionKey,
  lastProvisionKey: () => ctx.store.value.provisionKey || "",
  // About a hundred small files on each side; one that can't be read counts as changed (provisioning puts it back).
  pluginEdited: async () => {
    const digests = await Promise.all([pluginDigest(path.join(ctx.paths.plugins, "chief-dashboard-bridge")), pluginDigest(installedPlugin(ctx.hermesRoot))]).catch(() => null);
    return !digests || digests[0] !== digests[1];
  },
  provision: () =>
    runPython(ctx.paths.provision, ["--plugins-src", ctx.paths.plugins, "--bridge-port", String(ctx.store.value.ports.bridge), ...(ctx.store.value.adopted ? ["--adopted"] : [])], {
      ...toolEnv("gateway"),
      HERMES_HOME: profileHome(ctx.hermesRoot),
      PYTHONPATH: payloadLayout(ctx.paths.payload).pythonPath.join(";"),
    }),
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
  backup: (onProgress) => preUpdateBackup(onProgress),
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
      assistant: assistantName,
      shouldNotify: () => !ctx.window || !ctx.window.isVisible() || !ctx.window.isFocused(),
      notify,
    });
    ctx.notifier.start();
    announceUpdate();
    void checkForUpdates().then(() => syncHistory());
  },
  quit: () => void shutdown(),
  name: assistantName,
  now: () => Date.now(),
  log: (event, fields) => log.info(event, fields),
});

/** A start, counted per version (boot.ts countedStart): two failed starts of a new version offer going back. */
async function runBoot() {
  if (boot.running) return boot.run();
  const version = app.getVersion();
  return countedStart({
    version,
    attempts: () => ctx.store.value.bootAttempts,
    healthyVersion: () => ctx.store.value.healthyVersion,
    saveAttempts: (bootAttempts, healthy) => ctx.store.save({ bootAttempts, ...(healthy ? { healthyVersion: version } : {}) }),
    boot: () => boot.run(),
    previous: async () => (await ctx.updater.rollbackOptions().catch(() => []))[0]?.version ?? "",
    offer: (to, attempts) => {
      // The boot page's Go back works only while the offer stands (ipc.ts boot:rollback).
      ctx.rollbackOffer = to;
      if (!to) return;
      log.warn("boot.rollback-offered", { from: version, to, attempts });
      ctx.window?.webContents.send("boot:offer", { rollback: to });
    },
  });
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
  // The start screen's steps only while it shows: over the dashboard, a boot would replace the page (and its drafts),
  // and the dashboard's own banner says Chief stopped and came back.
  const onBootPage = bootPageShown();
  // Chief (or the dashboard) came back by itself while the start screen shows a failure: carry on without Retry.
  if (recoversBoot(e, ctx.steps, boot.running, onBootPage)) {
    log.info("boot.recovered", { by: name });
    void runBoot();
  }
  if (name === "gateway" && e.type === "state" && e.state === "failed") {
    const assistant = assistantName();
    if (onBootPage) setStep("gateway", "error", `${e.detail} ${assistant} kept stopping, so the app tries again every 10 minutes. Press Try again to start it now.`);
    if (!ctx.window?.isFocused()) notify(`${assistant} stopped`, `It kept stopping, so the app will try again in 10 minutes. Click to open ${assistant}.`);
  }
}

/* ------------------------------------------------------------------ start */

registerBootScheme(protocol);
// Crash dumps stay on this PC (the diagnostics bundle collects them); nothing is uploaded.
crashReporter.start({ uploadToServer: false });
process.on("unhandledRejection", (reason) => log.error("process.unhandled-rejection", { reason: reason instanceof Error ? reason : String(reason) }));
process.on("uncaughtException", (error) => log.error("process.uncaught-exception", { error }));

// A debugging port lets any local program drive the window (and its whole desktop API): the installed app never opens one.
const debugging = ["remote-debugging-port", "remote-debugging-pipe", "inspect", "inspect-brk"].some((s) => app.commandLine.hasSwitch(s));
if (app.isPackaged && debugging) {
  log.warn("app.debugging-refused");
  app.exit(1);
}

// Every web contents, not only the main window's: exact-origin navigation and window rules, no webviews. The only
// guard: a second one on the main window (window.ts had one) opened each external link twice.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    const decision = windowOpenDecision(url, uiOrigin());
    if (decision === "external") void shell.openExternal(url);
    return { action: decision === "allow" ? "allow" : "deny" };
  });
  const guard = (event: Electron.Event, url: string) => {
    const decision = navigateDecision(url, uiOrigin(), BOOT_URL);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") void shell.openExternal(url);
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

if (!app.requestSingleInstanceLock() || (process.argv.includes("--quit") && !app.isReady())) {
  app.quit();
} else {
  // A second launch shows the window; `--quit` (an installer or updater) asks this instance to quit cleanly.
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--quit")) return void quit();
    // Closing already: the launch isn't lost, the app opens again once it has closed.
    if (ctx.quitting) return relaunchAfterQuit(argv);
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
    if (ctx.store.problem === "restored") log.warn("settings.restored", { detail: "desktop.json couldn't be read; its backup was used" });
    if (ctx.store.problem === "unreadable") log.error("settings.unreadable", { detail: "desktop.json and its backup couldn't be read; running on defaults, and the file is left as it is" });
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
      launch: async () => {
        // Phone requests are pinned to this PC's Tailscale name (runtime.ts envFor), which an older record learns now.
        await ensurePhoneHost();
        return launchWeb(utilityProcess as never, { serverJs: ctx.paths.webServer, port: ctx.store.value.ports.ui, env: envFor("web"), logFile: path.join(ctx.paths.logs, "dashboard.log") }, (code, pid) => ctx.web.exited(code, pid));
      },
      ready: async () => {
        const up = await waitFor(() => webHealth(ctx.store.value.ports.ui), 60_000);
        if (!up.ok) throw new Error(up.detail || "The dashboard didn't answer.");
        // Phone access was paused when the app last quit (phone.ts pauseServe).
        void resumeServe();
      },
      health: async () => (await webHealth(ctx.store.value.ports.ui, 5_000)).ok,
      onEvent: (e) => onSupervisorEvent("web", e),
    });
    ctx.updater = new Updater({
      source: () => {
        const feed = effectiveFeed(ctx.store.value.updateFeed, ctx.shippedFeed);
        if (!feed) return null;
        const repo = parseGithub(feed);
        ctx.updateSource = repo ? githubSource(repo.owner, repo.repo, readUpdateKey(ctx.paths.secrets, safeStorage), fetch, { early: () => ctx.store.value.earlyUpdates }) : folderSource(feed);
        return ctx.updateSource;
      },
      currentVersion: app.getVersion(),
      // The layout the data was last written in: a release that reads only an older one can't be gone back to.
      dataSchema: () => ctx.store.value.dataSchema || 0,
      publicKey: RELEASE_KEYS,
      // Beside the backups when the owner moved those off a full system drive.
      updatesDir: ctx.store.value.backupDir ? path.join(path.dirname(ctx.store.value.backupDir), "updates") : path.join(ctx.paths.data, "updates"),
      skipped: () => ctx.store.value.skippedVersions,
      freeBytes: async (dir) => {
        const s = statfsSync(existsSync(dir) ? dir : ctx.paths.data);
        return s.bavail * s.bsize;
      },
      activeWork: () => currentWork(),
      // While preparing: the full backup only when the release brings a different upstream Hermes (the only thing
      // that migrates data). The first start of the new version backs up again, at the last moment, before Hermes
      // starts; the same Hermes with different app patches is caught there too.
      backup: (release: Release, onProgress) => (release.hermes?.commit && release.hermes.commit === hermesUpstream() ? Promise.resolve({ ok: true }) : preUpdateBackup(onProgress)),
      stage: async (file, release, onProgress) => {
        const dir = updaterDir(ctx.paths.appDir);
        const helper = app.isPackaged ? helperCopy(process.resourcesPath, dir, app.getVersion()) : null;
        if (!helper) return { ok: false, error: "no update helper in this build" };
        const job = path.join(dir, `stage-${release.version}.json`);
        writeFileSync(
          job,
          JSON.stringify({
            version: 1,
            mode: compareVersions(release.version, app.getVersion()) < 0 ? "rollback" : "update",
            packageFile: file,
            packageSha256: release.package.sha256,
            packageName: PACKAGE_NAME,
            from: app.getVersion(),
            to: release.version,
            logFile: path.join(ctx.paths.logs, "update-install.log"),
          }),
        );
        const staged = await runStage(helper, job, onProgress);
        log.info("update.staged", { version: release.version, ok: staged.ok, error: staged.error });
        return staged;
      },
      stopChief: async () => {
        // Chief's face and colour for the update window, taken while the page still shows it awake (once the
        // gateway stops, the face goes to sleep and the page dims).
        chiefLook = await readChiefLook();
        ctx.notifier?.stop();
        await ctx.web.stop(true).catch(() => undefined);
        if (!ctx.externalGateway) await ctx.gateway.stop(true).catch(() => undefined);
      },
      startChief: async () => {
        if (!ctx.externalGateway) await ctx.gateway.start();
        await ctx.web.start();
        ctx.notifier?.start();
      },
      handOff: (file, release) => {
        if (!app.isPackaged) return Promise.resolve({ ok: false as const, error: "Updates install only in the installed app." });
        const dir = updaterDir(ctx.paths.appDir);
        const logFile = path.join(ctx.paths.logs, "update-install.log");
        const from = app.getVersion();
        // The helper works in physical pixels; Electron's bounds are in DIPs, scaled per display (a window on a 150 %
        // screen beside a 100 % one isn't at its DIP origin times 1.5).
        const bounds = ctx.window && !ctx.window.isMinimized() && ctx.window.isVisible() ? screen.dipToScreenRect(ctx.window, ctx.window.getBounds()) : null;
        return handOff({
          dir,
          helper: () => helperCopy(process.resourcesPath, dir, from),
          job: {
            version: 1,
            mode: compareVersions(release.version, from) < 0 ? "rollback" : "update",
            from,
            to: release.version,
            packageFile: file,
            packageSha256: release.package.sha256,
            packageName: PACKAGE_NAME,
            appId: APP_ID,
            appPid: process.pid,
            window: bounds ? { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) } : null,
            accent: chiefLook.accent || "#E5484D",
            theme: lookTheme(ctx.store.value.themeMode, nativeTheme.shouldUseDarkColors),
            assistantName: chiefLook.name || assistantName(),
            logFile,
            reducedMotion: chiefLook.reducedMotion,
          },
          writeFace: async (target) => {
            if (!chiefLook.png) return false;
            writeFileSync(target, chiefLook.png);
            return true;
          },
          launch: (commandLine, show) => launchDetached(commandLine, show),
          fallback: () => fallbackCommandLine(installScript(file, logFile, resultFile(dir), from, release.version, release.package.sha256, compareVersions(release.version, from) < 0)),
          kill: (pid) => {
            try {
              process.kill(pid);
            } catch {
              /* already gone */
            }
          },
          quit: () => void shutdown({ hide: true }),
          log: (line) => logLine("update-install.log", line),
        });
      },
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
    setInterval(() => void checkForUpdates().then(() => syncHistory()), 24 * 3600 * 1000).unref();
    // How the last update went, from the helper (or the fallback installer): one that didn't finish is reported once.
    const lastUpdate = readResult(updaterDir(ctx.paths.appDir));
    if (lastUpdate) logLine("update-install.log", `result ${lastUpdate.from} -> ${lastUpdate.to}: ${lastUpdate.ok ? "ok" : `failed at ${lastUpdate.step}: ${lastUpdate.message}`}`);
    const failed = resultMessage(lastUpdate, app.getVersion());
    if (failed && lastUpdate) ctx.updater.noteFailedUpdate(failed, lastUpdate.to);
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
    // A helper waiting on this start (after an update, or a failed one) closes its window once this one is up.
    ctx.window?.webContents.once("did-finish-load", () => markReady(updaterDir(ctx.paths.appDir), app.getVersion()));
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
