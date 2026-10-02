import type { BrowserWindow, Tray } from "electron";

import type { DesktopAction } from "./guards";
import { originOf } from "./guards";
import { Logger } from "./logger";
import type { Notifier } from "./notifier";
import type { DesktopPaths } from "./paths";
import { newSessionSecret } from "./session";
import type { Store } from "./store";
import type { Supervisor } from "./supervisor";
import type { Updater } from "./updater";

/**
 * The desktop shell's shared state, one object the modules read and write (main.ts fills it at start-up).
 * Everything here lives for one launch; what must survive a restart is in the Store.
 */
export type Step = { id: string; label: string; state: "waiting" | "working" | "done" | "error"; detail?: string };

export const ctx = {
  paths: undefined as unknown as DesktopPaths,
  store: undefined as unknown as Store,
  /** The bridge token (sealed on disk by secrets.ts). */
  token: "",
  /** The dashboard's session secret for this launch (session.ts); never written to disk. */
  sessionSecret: newSessionSecret(),
  hermesRoot: "",
  window: null as BrowserWindow | null,
  tray: null as Tray | null,
  gateway: undefined as unknown as Supervisor,
  web: undefined as unknown as Supervisor,
  notifier: null as Notifier | null,
  quitting: false,
  /** Chief runs under another launcher and the owner chose to use it as is: never stopped or restarted here. */
  externalGateway: false,
  steps: [] as Step[],
  updater: undefined as unknown as Updater,
  /** The update source this build carries (a tester's install knows its releases repository from the start). */
  shippedFeed: "",
  /** The version this start replaced, when it is the first start after an update ("" otherwise). */
  updatedFrom: "",
  /** The earlier version the boot page offers to go back to, after this version failed to start twice. */
  rollbackOffer: "",
  /** A jump-list action from the launch that started the app, until the dashboard takes it. */
  pendingAction: null as DesktopAction | null,
};

/** The desktop log (logs/main.jsonl); the token and the session secret are redacted from every line. */
export const log = new Logger(() => ctx.paths?.logs ?? "");
log.addSecret(ctx.sessionSecret);

export function uiUrl() {
  return `http://127.0.0.1:${ctx.store.value.ports.ui}`;
}

export function uiOrigin() {
  return originOf(uiUrl());
}

export function hiddenLaunch() {
  return process.argv.includes("--hidden");
}

export const STEPS: Step[] = [
  { id: "runtime", label: "Runtime", state: "waiting" },
  { id: "prepare", label: "Preparing Chief", state: "waiting" },
  { id: "gateway", label: "Chief", state: "waiting" },
  { id: "web", label: "Dashboard", state: "waiting" },
];

export function setStep(id: string, state: Step["state"], detail = "") {
  ctx.steps = ctx.steps.map((s) => (s.id === id ? { ...s, state, detail } : s));
  ctx.window?.webContents.send("boot:status", ctx.steps);
}
