import { contextBridge, ipcRenderer } from "electron";

/**
 * What the page may ask of the shell (apps/web/lib/desktop.ts describes the same shape). No Node, no paths
 * beyond what the owner picks in a dialog, no secrets.
 */
contextBridge.exposeInMainWorld("chiefDesktop", {
  pickFolder: (options?: { title?: string; defaultPath?: string }) => ipcRenderer.invoke("desktop:pickFolder", options),
  pickFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => ipcRenderer.invoke("desktop:pickFile", options),
  applyRestore: () => ipcRenderer.invoke("desktop:applyRestore"),
  updates: {
    state: () => ipcRenderer.invoke("updates:state"),
    check: () => ipcRenderer.invoke("updates:check"),
    download: () => ipcRenderer.invoke("updates:download"),
    install: (force?: boolean) => ipcRenderer.invoke("updates:install", !!force),
    skip: (version: string) => ipcRenderer.invoke("updates:skip", version),
    feed: () => ipcRenderer.invoke("updates:feed"),
    setFeed: (folder: string) => ipcRenderer.invoke("updates:setFeed", folder),
    onState: (fn: (state: unknown) => void) => {
      const listener = (_e: unknown, state: unknown) => fn(state);
      ipcRenderer.on("updates:state", listener);
      return () => ipcRenderer.removeListener("updates:state", listener);
    },
  },
});

// The boot screen (static/boot.html) only.
contextBridge.exposeInMainWorld("chiefBoot", {
  onStatus: (fn: (steps: unknown) => void) => ipcRenderer.on("boot:status", (_e, steps) => fn(steps)),
  retry: () => ipcRenderer.invoke("boot:retry"),
  openLogs: () => ipcRenderer.invoke("boot:logs"),
});
