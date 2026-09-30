import { contextBridge, ipcRenderer } from "electron";

/**
 * What the page may ask of the shell (apps/web/lib/desktop.ts describes the same shape). No Node, no paths
 * beyond what the owner picks in a dialog, no secrets.
 */
contextBridge.exposeInMainWorld("chiefDesktop", {
  pickFolder: (options?: { title?: string; defaultPath?: string }) => ipcRenderer.invoke("desktop:pickFolder", options),
  pickFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) => ipcRenderer.invoke("desktop:pickFile", options),
  applyRestore: () => ipcRenderer.invoke("desktop:applyRestore"),
});

// The boot screen (static/boot.html) only.
contextBridge.exposeInMainWorld("chiefBoot", {
  onStatus: (fn: (steps: unknown) => void) => ipcRenderer.on("boot:status", (_e, steps) => fn(steps)),
  retry: () => ipcRenderer.invoke("boot:retry"),
  openLogs: () => ipcRenderer.invoke("boot:logs"),
});
