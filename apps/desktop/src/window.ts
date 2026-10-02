import path from "node:path";

import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, session, shell, Tray } from "electron";

import { activeWork, fromBridgeSnapshot } from "./active-work";
import { waitFor } from "./gateway";
import { BOOT_URL, DESKTOP_ACTIONS, navigateDecision, sameOrigin, windowOpenDecision, type DesktopAction } from "./guards";
import { logLine } from "./runtime";
import { openTicket, sessionCookieName } from "./session";
import { ctx, hiddenLaunch, log, uiOrigin, uiUrl, type Step } from "./state";

/* The window, the tray, the taskbar's jump list, and quitting. */

export function showWindow() {
  const { window } = ctx;
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** A jump-list or tray shortcut: show the window and hand the action to the dashboard (or keep it until the
 * dashboard has loaded, for a launch that started the app). */
export function runAction(action: DesktopAction) {
  showWindow();
  const { window } = ctx;
  const url = window?.webContents.getURL() || "";
  if (window && sameOrigin(url, uiOrigin()) && !window.webContents.isLoading()) window.webContents.send("desktop:action", action);
  else ctx.pendingAction = action;
}

/** The taskbar's jump list (Windows): each task relaunches the app with `--action=…`, which reaches this instance. */
export function setJumpList() {
  if (process.platform !== "win32") return;
  try {
    app.setUserTasks(
      DESKTOP_ACTIONS.map((a) => ({
        program: process.execPath,
        arguments: [...(app.isPackaged ? [] : [app.getAppPath()]), `--action=${a.id}`].join(" "),
        iconPath: process.execPath,
        iconIndex: 0,
        title: a.title,
        description: a.description,
      })),
    );
  } catch (error) {
    log.warn("jump-list.not-set", { error });
  }
}

/**
 * The first start after an update is launched by the installer, a hidden background process, and Windows'
 * focus-stealing protection keeps such a window behind the others (or only in the taskbar). Raise it above
 * every window for a moment, then let the order settle; if Windows still withholds focus, flash the taskbar
 * button until the owner looks.
 */
export function bringToFront() {
  const { window } = ctx;
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.setAlwaysOnTop(true);
  window.moveTop();
  window.focus();
  setTimeout(() => {
    ctx.window?.setAlwaysOnTop(false);
    if (ctx.window && !ctx.window.isFocused()) ctx.window.flashFrame(true);
  }, 800);
}

/** After an update, once Chief is up: a Windows notification that opens the app, and a line in the install log. */
export function announceUpdate() {
  if (!ctx.updatedFrom) return;
  const version = app.getVersion();
  logLine("update-install.log", `ready ${version}; window ${ctx.window?.isVisible() ? "shown" : "hidden"}${ctx.window?.isFocused() ? ", in front" : ""}`);
  notify(`Chief updated to ${version}`, "It's running again. Click to open it.");
  ctx.updatedFrom = "";
}

export function notify(title: string, body: string) {
  const n = new Notification({ title, body, icon: ctx.paths.icon });
  n.on("click", showWindow);
  n.show();
}

/** The boot page with these steps (start-up, a page that didn't load, quitting). */
export async function showBootPage(steps: Step[]) {
  ctx.steps = steps;
  await ctx.window?.loadURL(BOOT_URL).catch(() => undefined);
  ctx.window?.webContents.send("boot:status", ctx.steps);
}

/** The window's session cookie for the dashboard's port (set again whenever the port may have moved). */
export async function setSessionCookie() {
  await session.defaultSession.cookies.set({ url: uiUrl(), name: sessionCookieName(ctx.store.value.ports.ui), value: ctx.sessionSecret, httpOnly: true, sameSite: "strict" });
}

/** Chief in the owner's own browser on this PC: a link with a ticket the dashboard swaps for the session cookie. */
export function openInBrowser() {
  void shell.openExternal(`${uiUrl()}/?open=${openTicket(ctx.sessionSecret)}`);
}

/** A renderer that crashes is reloaded, but not in a loop: three times in five minutes, then the boot page says so. */
const RELOADS = 3;
const RELOAD_WINDOW_MS = 5 * 60_000;
const reloads: number[] = [];

export function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    show: !hiddenLaunch(),
    backgroundColor: "#09090b",
    title: "Chief Command Center",
    // No grey Windows title bar: minimize, maximize and close are drawn over the top-right of the app's own
    // header (Window Controls Overlay), which is a drag region and keeps clear of them (globals.css --wco).
    // Snap layouts and the window shadow stay, as with a normal frame.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#00000000", symbolColor: "#a1a1aa", height: 60 },
    // Electron 44 remembers the window's size, position and maximized state between starts (by this name).
    name: "chief-main",
    windowStatePersistence: true,
    icon: ctx.paths.icon,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  ctx.window = window;
  window.once("ready-to-show", () => log.info("window.first-paint", { msSinceStart: Math.round(process.uptime() * 1000) }));
  // Exact origins (guards.ts): a window the dashboard opens inherits the preload, so only its own pages may.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const decision = windowOpenDecision(url, uiOrigin());
    if (decision === "external") void shell.openExternal(url);
    return { action: decision === "allow" ? "allow" : "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const decision = navigateDecision(url, uiOrigin(), BOOT_URL);
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") void shell.openExternal(url);
  });
  // The dashboard didn't load (its server went away between the health check and the page): the boot page, with Retry.
  window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted by a newer navigation */ || !sameOrigin(url, uiOrigin()) || ctx.quitting) return;
    log.warn("window.load-failed", { code, description });
    void showBootPage(ctx.steps.map((s) => (s.id === "web" ? { ...s, state: "error", detail: `The dashboard didn't load (${description}).` } : s.state === "waiting" ? { ...s, state: "done" } : s)));
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    log.error("window.renderer-gone", { reason: details.reason, exitCode: details.exitCode });
    if (ctx.quitting) return;
    const now = Date.now();
    while (reloads.length && now - reloads[0] > RELOAD_WINDOW_MS) reloads.shift();
    if (reloads.length < RELOADS) {
      reloads.push(now);
      ctx.window?.webContents.reload();
      return;
    }
    void showBootPage(ctx.steps.map((s) => (s.id === "web" ? { ...s, state: "error", detail: "The window kept stopping. Try again, and if it repeats, send the diagnostics from Settings → About." } : s)));
  });
  window.on("focus", () => ctx.window?.flashFrame(false));
  window.on("close", (event) => {
    if (ctx.quitting) return;
    event.preventDefault();
    ctx.window?.hide();
    if (!ctx.store.value.closeNoticeShown) {
      ctx.store.save({ closeNoticeShown: true });
      new Notification({ title: "Chief keeps running", body: "Chief is still here in the tray. Quit from the tray icon to stop Chief.", icon: ctx.paths.icon }).show();
    }
  });
  // Signing out or shutting Windows down: stop Chief now, without the "Chief is busy" question (there is no time).
  window.on("session-end", () => {
    log.info("windows.session-end");
    void stopEverything();
  });
}

export function createTray() {
  const tray = new Tray(nativeImage.createFromPath(ctx.paths.icon).resize({ width: 16, height: 16 }));
  ctx.tray = tray;
  tray.setToolTip("Chief Command Center");
  tray.on("click", showWindow);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Chief", click: showWindow },
      ...DESKTOP_ACTIONS.map((a) => ({ label: a.title, click: () => runAction(a.id) })),
      { type: "separator" },
      { label: "Open in browser", click: openInBrowser },
      {
        label: "Restart Chief",
        click: () => {
          log.info("gateway.restart-requested");
          void ctx.gateway.stop(true).then(() => ctx.gateway.start());
        },
      },
      { label: "Open logs", click: () => void shell.openPath(ctx.paths.logs) },
      { type: "separator" },
      { label: "Quit", click: () => void quit() },
    ]),
  );
}

export async function currentWork() {
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.store.value.ports.bridge}/snapshot`, { headers: { Authorization: `Bearer ${ctx.token}` }, signal: AbortSignal.timeout(3000) });
    return activeWork(fromBridgeSnapshot(await res.json()));
  } catch {
    return { busy: false, reasons: [] };
  }
}

async function stopEverything() {
  ctx.quitting = true;
  ctx.notifier?.stop();
  await ctx.web.stop(true).catch(() => undefined);
  if (!ctx.externalGateway) await ctx.gateway.stop(true).catch(() => undefined);
}

export async function quit() {
  if (ctx.quitting) return;
  if (!ctx.externalGateway) {
    let work = await currentWork();
    while (work.busy) {
      const choice = await dialog.showMessageBox(ctx.window!, {
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
  log.info("app.quit");
  ctx.tray?.destroy();
  // Chief can take a while to finish what it's doing: past a second, the window says so instead of hanging.
  const feedback = setTimeout(() => {
    if (ctx.window?.isVisible()) void showBootPage([{ id: "quit", label: "Stopping Chief", state: "working", detail: "Letting Chief finish and save. This can take up to half a minute." }]);
  }, 1000);
  await stopEverything();
  clearTimeout(feedback);
  app.exit(0);
}
