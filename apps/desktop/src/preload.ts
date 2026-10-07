import { contextBridge, ipcRenderer } from "electron";

/**
 * What the page may ask of the shell (apps/web/lib/desktop.ts describes the same shape). No Node, no paths
 * beyond what the owner picks in a dialog, no secrets.
 */
contextBridge.exposeInMainWorld("chiefDesktop", {
  pickFolder: (options?: { title?: string; defaultPath?: string }) => ipcRenderer.invoke("desktop:pickFolder", options),
  pickFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => ipcRenderer.invoke("desktop:pickFile", options),
  applyRestore: () => ipcRenderer.invoke("desktop:applyRestore"),
  openLogs: () => ipcRenderer.invoke("desktop:openLogs"),
  openNotices: () => ipcRenderer.invoke("desktop:openNotices"),
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
  onStatus: (fn: (steps: unknown) => void) => ipcRenderer.on("boot:status", (_e, steps) => fn(steps)),
  retry: () => ipcRenderer.invoke("boot:retry"),
  openLogs: () => ipcRenderer.invoke("boot:logs"),
  /** After two failed starts of a new version: "Go back to X.Y.Z" when its package is still on this PC. */
  onOffer: (fn: (offer: unknown) => void) => ipcRenderer.on("boot:offer", (_e, offer) => fn(offer)),
  rollback: () => ipcRenderer.invoke("boot:rollback"),
});
