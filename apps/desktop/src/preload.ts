import { contextBridge, ipcRenderer } from "electron";

/**
 * What the page may ask of the shell (apps/web/lib/desktop.ts describes the same shape). No Node, no paths
 * beyond what the owner picks in a dialog, no secrets.
 */
contextBridge.exposeInMainWorld("chiefDesktop", {
  pickFolder: (options?: { title?: string; defaultPath?: string }) => ipcRenderer.invoke("desktop:pickFolder", options),
  pickFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => ipcRenderer.invoke("desktop:pickFile", options),
  applyRestore: () => ipcRenderer.invoke("desktop:applyRestore"),
  /** Where applyRestore is ({ step, fraction }, fraction 0 to 1 or null); returns an unsubscribe. */
  onRestoreProgress: (fn: (progress: unknown) => void) => {
    const listener = (_e: unknown, progress: unknown) => fn(progress);
    ipcRenderer.on("desktop:restoreProgress", listener);
    return () => void ipcRenderer.removeListener("desktop:restoreProgress", listener);
  },
  openLogs: () => ipcRenderer.invoke("desktop:openLogs"),
  openNotices: () => ipcRenderer.invoke("desktop:openNotices"),
  /** The app's look's mode (dark, light, system): the window's colours and Electron's own theme follow it. */
  setThemeMode: (mode: string) => ipcRenderer.invoke("desktop:setThemeMode", mode),
  /** The assistant's name, for notifications, the tray and the shell's dialogs (1 to 40 characters; false when refused). */
  setAssistantName: (name: string) => ipcRenderer.invoke("desktop:setAssistantName", name),
  /** Settings → About: logs, crash dumps and versions in a zip the owner saves and sends themselves. */
  diagnostics: () => ipcRenderer.invoke("desktop:diagnostics"),
  /** Report a problem: the same zip, saved straight to Downloads with Explorer opened on it. */
  reportDiagnostics: () => ipcRenderer.invoke("desktop:reportDiagnostics"),
  /** Chief's engine and the dashboard server (the banner when Chief restarts or stops), and "Try now". */
  engine: () => ipcRenderer.invoke("desktop:engine"),
  retryChief: () => ipcRenderer.invoke("desktop:retryChief"),
  onEngine: (fn: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown) => fn(state);
    ipcRenderer.on("desktop:engine", listener);
    return () => void ipcRenderer.removeListener("desktop:engine", listener);
  },
  /** Jump-list and tray shortcuts (guards.ts DESKTOP_ACTIONS); the one a launch brought is delivered first. */
  onAction: (fn: (action: string) => void) => {
    const listener = (_event: unknown, action: string) => fn(action);
    ipcRenderer.on("desktop:action", listener);
    void ipcRenderer.invoke("desktop:takeAction").then((action: string | null) => action && fn(action));
    return () => void ipcRenderer.removeListener("desktop:action", listener);
  },
  updates: {
    state: () => ipcRenderer.invoke("updates:state"),
    check: () => ipcRenderer.invoke("updates:check"),
    prepare: () => ipcRenderer.invoke("updates:prepare"),
    restart: (force?: boolean) => ipcRenderer.invoke("updates:restart", !!force),
    options: () => ipcRenderer.invoke("updates:options"),
    setOptions: (options: { prepare?: boolean; early?: boolean }) => ipcRenderer.invoke("updates:setOptions", options),
    skip: (version: string) => ipcRenderer.invoke("updates:skip", version),
    feed: () => ipcRenderer.invoke("updates:feed"),
    setFeed: (folder: string) => ipcRenderer.invoke("updates:setFeed", folder),
    hasKey: () => ipcRenderer.invoke("updates:hasKey"),
    keyStatus: () => ipcRenderer.invoke("updates:keyStatus"),
    installVersion: (version: string) => ipcRenderer.invoke("updates:installVersion", version),
    setKey: (key: string) => ipcRenderer.invoke("updates:setKey", key),
    history: () => ipcRenderer.invoke("updates:history"),
    rollbackOptions: () => ipcRenderer.invoke("updates:rollbackOptions"),
    rollback: (version: string) => ipcRenderer.invoke("updates:rollback", version),
    onState: (fn: (state: unknown) => void) => {
      const listener = (_e: unknown, state: unknown) => fn(state);
      ipcRenderer.on("updates:state", listener);
      return () => ipcRenderer.removeListener("updates:state", listener);
    },
  },
  // Settings → Phone: Tailscale's state, and the one Serve entry the app manages.
  phone: {
    state: () => ipcRenderer.invoke("phone:state"),
    enable: (port?: number) => ipcRenderer.invoke("phone:enable", port),
    disable: () => ipcRenderer.invoke("phone:disable"),
    setAccess: (mode: "owner" | "tailnet") => ipcRenderer.invoke("phone:setAccess", mode),
    open: (url: string) => ipcRenderer.invoke("phone:open", url),
  },
});

// The boot screen (static/boot.html) only.
contextBridge.exposeInMainWorld("chiefBoot", {
  /** The steps, and what the heading needs ({ name }). */
  onStatus: (fn: (steps: unknown, meta: unknown) => void) => ipcRenderer.on("boot:status", (_e, steps, meta) => fn(steps, meta)),
  retry: () => ipcRenderer.invoke("boot:retry"),
  openLogs: () => ipcRenderer.invoke("boot:logs"),
  /** The diagnostics zip, saved to Downloads with Explorer opened on it ({ ok, name } or { ok: false, error }). */
  saveDiagnostics: () => ipcRenderer.invoke("boot:diagnostics"),
  /** After two failed starts of a new version: "Go back to X.Y.Z" when its package is still on this PC. */
  onOffer: (fn: (offer: unknown) => void) => ipcRenderer.on("boot:offer", (_e, offer) => fn(offer)),
  rollback: () => ipcRenderer.invoke("boot:rollback"),
  /** How going back is getting on (the updater's states: backing up, unpacking, restarting, an error). */
  onUpdate: (fn: (state: unknown) => void) => ipcRenderer.on("updates:state", (_e, state) => fn(state)),
  /** The waiting screen while quitting. */
  quitNow: () => ipcRenderer.invoke("boot:quitWait", "quit"),
  keepRunning: () => ipcRenderer.invoke("boot:quitWait", "stay"),
});
