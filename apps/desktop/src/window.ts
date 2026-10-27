import path from "node:path";

import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, Notification, screen, session, shell, Tray } from "electron";

import { activeWork, fromBridgeSnapshot } from "./active-work";
import { BOOT_URL, DESKTOP_ACTIONS, isBootPage, navigateDecision, sameOrigin, windowColors, windowOpenDecision, type DesktopAction, type ThemeMode } from "./guards";
import { pauseServe } from "./phone";
import { createQuitter, type WaitChoice } from "./quitting";
import { logLine } from "./runtime";
import { openTicket, sessionCookieName, sessionCookieValue } from "./session";
import { assistantName, bootMeta, bootSteps, ctx, hiddenLaunch, log, uiOrigin, uiUrl, type Step } from "./state";

/* The window, the tray, the taskbar's jump list, and quitting. */

export function showWindow() {
  const { window } = ctx;
  if (!window || window.isDestroyed()) return;
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
  const name = assistantName();
  try {
    app.setUserTasks(
      DESKTOP_ACTIONS.map((a) => ({
        program: process.execPath,
        arguments: [...(app.isPackaged ? [] : [app.getAppPath()]), `--action=${a.id}`].join(" "),
        iconPath: process.execPath,
        iconIndex: 0,
        title: a.title,
        description: a.description(name),
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

/** After an update, once Chief is up: a line in the install log, and a Windows notification that opens the app
 * unless the window is already in front (bringToFront usually got it there). */
export function announceUpdate() {
  if (!ctx.updatedFrom) return;
  const version = app.getVersion();
  const shown = !!ctx.window?.isVisible();
  const inFront = shown && !!ctx.window?.isFocused();
  logLine("update-install.log", `ready ${version}; window ${shown ? "shown" : "hidden"}${inFront ? ", in front" : ""}`);
  if (!inFront) notify(`${assistantName()} updated to ${version}`, "It's running again. Click to open it.");
  ctx.updatedFrom = "";
}

/** A Windows notification; clicking it shows the window. */
export function notify(title: string, body: string) {
  const n = new Notification({ title, body, icon: ctx.paths.icon });
  n.on("click", showWindow);
  n.show();
}

/** The window shows the boot page (start-up, a failure, waiting for Chief or closing), not the dashboard. */
export function bootPageShown(): boolean {
  const window = ctx.window;
  return !!window && !window.isDestroyed() && isBootPage(window.webContents.getURL());
}

/** The boot page with these steps (start-up, a page that didn't load, quitting). */
export async function showBootPage(steps: Step[]) {
  ctx.steps = steps;
  const window = ctx.window;
  if (!window || window.isDestroyed()) return;
  await window.loadURL(BOOT_URL).catch(() => undefined);
  if (!window.isDestroyed()) window.webContents.send("boot:status", ctx.steps, bootMeta());
}

/** The window's session cookie for the dashboard's port (set again whenever the port may have moved). */
export async function setSessionCookie() {
  await session.defaultSession.cookies.set({ url: uiUrl(), name: sessionCookieName(ctx.store.value.ports.ui), value: sessionCookieValue(ctx.sessionSecret), httpOnly: true, sameSite: "strict" });
}

/** Chief in the owner's own browser on this PC: a link with a ticket the dashboard swaps for the session cookie. */
export function openInBrowser() {
  void shell.openExternal(`${uiUrl()}/?open=${openTicket(ctx.sessionSecret)}`);
}

/** A renderer that crashes is reloaded, but not in a loop: three times in five minutes, then the boot page says so. */
const RELOADS = 3;
const RELOAD_WINDOW_MS = 5 * 60_000;
const reloads: number[] = [];

/** Follow the app's look: Electron's own theme (dialogs, "system", the boot page), the window's background and
 * title-bar symbols. */
export function applyThemeMode(mode: ThemeMode) {
  nativeTheme.themeSource = mode;
  const colors = windowColors(mode, nativeTheme.shouldUseDarkColors);
  const window = ctx.window;
  if (window && !window.isDestroyed()) {
    window.setBackgroundColor(colors.background);
    window.setTitleBarOverlay({ color: "#00000000", symbolColor: colors.symbols, height: 60 });
  }
}

export function createWindow() {
  const mode = ctx.store.value.themeMode;
  nativeTheme.themeSource = mode;
  const colors = windowColors(mode, nativeTheme.shouldUseDarkColors);
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    show: !hiddenLaunch(),
    backgroundColor: colors.background,
    title: "Chief Command Center",
    // No grey Windows title bar: minimize, maximize and close are drawn over the top-right of the app's own
    // header (Window Controls Overlay), which is a drag region and keeps clear of them (globals.css --wco).
    // Snap layouts and the window shadow stay, as with a normal frame.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#00000000", symbolColor: colors.symbols, height: 60 },
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
    void showBootPage(ctx.steps.map((s) => (s.id === "web" ? { ...s, state: "error", detail: "The dashboard didn't open. Try again." } : s.state === "waiting" ? { ...s, state: "done" } : s)));
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
    const detail = "The window kept stopping. Try again. If it keeps happening, press Save diagnostics and send the file to whoever helps you with the app.";
    void showBootPage(ctx.steps.map((s) => (s.id === "web" ? { ...s, state: "error", detail } : s)));
  });
  window.on("focus", () => ctx.window?.flashFrame(false));
  window.on("close", (event) => {
    if (ctx.quitting) return;
    event.preventDefault();
    ctx.window?.hide();
    if (!ctx.store.value.closeNoticeShown) {
      ctx.store.save({ closeNoticeShown: true });
      const name = assistantName();
      // Windows 11 keeps most tray icons under the ^ beside the clock: say where to look.
      notify(`${name} keeps running`, `${name} is still here: its icon is by the clock (under the ^ if you don't see it). Click it to open ${name}; right-click it and choose Quit to stop.`);
    }
  });
  // Closed only while quitting (otherwise it hides): nothing may reach for it afterwards.
  window.on("closed", () => {
    if (ctx.window === window) ctx.window = null;
  });
  // Signing out or shutting Windows down: stop Chief now, without the "Chief is busy" question (there is no time).
  window.on("session-end", () => {
    log.info("windows.session-end");
    void quitter.shutdown();
  });
}

/**
 * The tray's face at the size Windows draws it. Electron turns only the image's 1x bitmap into the tray's icon, so a
 * 16 px image is stretched (blurry) at 125 % to 200 %: the bitmap is made at the primary display's scale instead,
 * from the 32 px source.
 */
function trayImage() {
  const source = nativeImage.createFromPath(ctx.paths.trayIcon);
  const width = source.getSize().width;
  if (!width) return source;
  const size = Math.min(width, Math.round(16 * (screen.getPrimaryDisplay().scaleFactor || 1)));
  return size === width ? source : source.resize({ width: size, height: size, quality: "best" });
}

export function createTray() {
  const tray = new Tray(trayImage());
  ctx.tray = tray;
  tray.on("click", showWindow);
  refreshTray();
  // The owner changed the display scale: the icon follows.
  screen.on("display-metrics-changed", (_event, display, changed) => {
    if (changed.includes("scaleFactor") && display.id === screen.getPrimaryDisplay().id && !tray.isDestroyed()) tray.setImage(trayImage());
  });
}

/** Restart Chief from the tray; never a gateway another launcher runs (the owner chose "Use it as is"). */
function restartChief() {
  if (ctx.externalGateway || ctx.quitting) return;
  log.info("gateway.restart-requested");
  void ctx.gateway.stop(true).then(() => ctx.gateway.start());
}

/** The tray's tooltip and menu, again whenever what they show changes (the name, another launcher's gateway, closing). */
export function refreshTray() {
  const tray = ctx.tray;
  if (!tray || tray.isDestroyed()) return;
  const name = assistantName();
  if (ctx.quitting) {
    tray.setToolTip(`Closing ${name}…`);
    tray.setContextMenu(Menu.buildFromTemplate([{ label: `Closing ${name}…`, enabled: false }]));
    return;
  }
  tray.setToolTip("Chief Command Center");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${name}`, click: showWindow },
      ...DESKTOP_ACTIONS.map((a) => ({ label: a.title, click: () => runAction(a.id) })),
      { type: "separator" },
      { label: "Open in browser", click: openInBrowser },
      ...(ctx.externalGateway ? [] : [{ label: `Restart ${name}`, click: restartChief }]),
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

/* ------------------------------------------------------------------ quitting (quitting.ts) */

/** The closing screen; it also says when a launch during the closing will open the app again. */
function showClosing() {
  const name = assistantName();
  const again = quitter.relaunching ? " The app opens again once it has closed." : "";
  void showBootPage([{ id: "quit", label: `Closing ${name}`, state: "working", detail: `Letting ${name} finish and save.${again}` }]);
}

const quitter = createQuitter({
  work: currentWork,
  external: () => ctx.externalGateway,
  ask: async (reasons) => {
    const name = assistantName();
    const options = {
      type: "warning" as const,
      title: `${name} is busy`,
      message: `${name} is in the middle of something.`,
      detail: `${reasons.join("\n")}\n\nQuitting stops ${name} until you open the app again.`,
      buttons: [`Wait for ${name}`, "Quit now", "Cancel"],
      defaultId: 0,
      cancelId: 2,
    };
    const window = ctx.window && !ctx.window.isDestroyed() ? ctx.window : null;
    const choice = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    return choice.response === 0 ? "wait" : choice.response === 1 ? "quit" : "cancel";
  },
  showWaiting: async (reasons) => {
    const name = assistantName();
    showWindow();
    await showBootPage([{ id: "wait", label: `Waiting for ${name} to finish`, state: "working", detail: reasons.join(" ") }]);
  },
  reopen: async () => {
    // The start's steps again (all done), so a dashboard that doesn't load shows its error with Try again.
    ctx.steps = bootSteps().map((s) => ({ ...s, state: "done" }));
    await setSessionCookie().catch(() => undefined);
    await ctx.window?.loadURL(uiUrl()).catch(() => undefined);
  },
  closing: () => {
    ctx.quitting = true;
    refreshTray();
  },
  showClosing,
  hide: () => ctx.window?.hide(),
  stopNotifier: () => ctx.notifier?.stop(),
  pauseServe,
  stopWeb: () => ctx.web.stop(true),
  stopGateway: () => ctx.gateway.stop(true),
  relaunch: (args) => app.relaunch({ args }),
  // The tray icon stays through the closing (it says so) and goes just before the exit, leaving no stale icon.
  exit: () => {
    ctx.tray?.destroy();
    app.exit(0);
  },
  log: (event, fields) => log.info(event, fields),
});

/** Quit as the owner asked (the tray, an installer's `--quit`, Windows' own quit): one at a time. */
export function quit(): Promise<void> {
  return quitter.quit();
}

/** Stop everything and exit, without asking (the update handing over, the start screen's Quit, Windows signing out). */
export function shutdown(opts: { hide?: boolean } = {}): Promise<void> {
  return quitter.shutdown(opts);
}

/** The waiting screen's "Quit now" and "Keep running". */
export function answerQuitWait(choice: WaitChoice) {
  quitter.answer(choice);
}

/** A launch while the app is closing: the window says it opens again, and it does once the app has exited. */
export function relaunchAfterQuit(argv: readonly string[]) {
  const action = argv.filter((a) => /^--action=[a-z-]+$/.test(a));
  quitter.relaunchAfter([...(app.isPackaged ? [] : [app.getAppPath()]), ...action]);
  showWindow();
  showClosing();
}
