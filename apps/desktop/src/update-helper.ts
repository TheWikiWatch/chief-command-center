import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { HandOffResult, Release } from "./updater";

/**
 * The update helper (apps/desktop/updater-helper → ChiefUpdater.exe, docs/PLAN-2026-10-07 §1.3).
 *
 * - `stage`: a hidden child of the app. Windows unpacks the new package beside the installed one while Chief keeps
 *   working, and the helper prints its progress as JSON lines.
 * - `apply`: started through WMI, outside the app, because Windows shuts the package's processes down to replace
 *   it. It shows a small window ("Updating Chief", Chief's face, a progress bar), waits for the app to exit and the
 *   package to be quiet, registers the staged package (or installs the whole one), opens the new version and closes
 *   once that version's window is up (`ready-<version>`).
 *
 * The helper runs from a copy outside the package folder: the copy in the package is replaced by the very install it
 * performs. The job file is the whole contract between the two; the helper writes `update-result.json`, which the
 * next start reads (`readResult`).
 */

export type HelperJob = {
  version: 1;
  mode: "update" | "rollback";
  from: string;
  to: string;
  packageFile: string;
  packageName: string;
  appId: string;
  appPid: number;
  window: { x: number; y: number; width: number; height: number } | null;
  accent: string;
  facePng: string | null;
  assistantName: string;
  logFile: string;
  resultFile: string;
  shownFile: string;
  readyDir: string;
  reducedMotion: boolean;
};

export type UpdateResult = {
  version: 1;
  ok: boolean;
  from: string;
  to: string;
  step: string;
  message: string;
  hresult: string;
  finishedAt: string;
  via?: string;
};

export const HELPER_EXE = "ChiefUpdater.exe";
export const PACKAGE_NAME = "ChiefCommandCenter";
export const APP_ID = "ChiefCommandCenter";

/** Where the helper keeps its copy, jobs, markers and result: `<app data>\updater`. */
export function updaterDir(appDir: string): string {
  return path.join(appDir, "updater");
}

export const shownFile = (dir: string, version: string) => path.join(dir, `shown-${version}`);
export const readyFile = (dir: string, version: string) => path.join(dir, `ready-${version}`);
export const resultFile = (dir: string) => path.join(dir, "update-result.json");

/**
 * The helper copied out of the package (`ChiefUpdater-<app version>.exe`), refreshed when the bundled one differs in
 * size; copies left by older versions are removed. Null when this build has no helper (a dev run, or a package built
 * before it existed).
 */
export function helperCopy(resourcesDir: string, dir: string, appVersion: string): string | null {
  const source = path.join(resourcesDir, "updater", HELPER_EXE);
  if (!existsSync(source)) return null;
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `ChiefUpdater-${appVersion}.exe`);
  if (!existsSync(target) || statSync(target).size !== statSync(source).size) copyFileSync(source, target);
  const config = `${source}.config`;
  if (existsSync(config)) copyFileSync(config, `${target}.config`);
  for (const name of readdirSync(dir)) {
    if (/^ChiefUpdater-\d+\.\d+\.\d+\.exe(\.config)?$/.test(name) && !name.startsWith(`ChiefUpdater-${appVersion}.exe`)) {
      rmSync(path.join(dir, name), { force: true });
    }
  }
  return target;
}

/** One line of the helper's `stage` output. */
export type StageLine = { phase: "staging"; pct: number } | { phase: "staged"; fullName: string } | { phase: "error"; message: string; hresult?: string };

export function parseStageLine(line: string): StageLine | null {
  try {
    const v = JSON.parse(line) as Partial<StageLine> & Record<string, unknown>;
    if (v.phase === "staging" && typeof v.pct === "number") return { phase: "staging", pct: Math.max(0, Math.min(100, Math.round(v.pct))) };
    if (v.phase === "staged" && typeof v.fullName === "string") return { phase: "staged", fullName: v.fullName };
    if (v.phase === "error") return { phase: "error", message: String(v.message || "staging failed"), hresult: typeof v.hresult === "string" ? v.hresult : undefined };
  } catch {
    /* not a protocol line */
  }
  return null;
}

/** Runs `helper stage --job <file>`; resolves when the helper exits. Staging that takes over 20 minutes is given up. */
export function runStage(helper: string, jobPath: string, onProgress: (pct: number) => void, timeoutMs = 20 * 60_000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(helper, ["stage", "--job", jobPath], { windowsHide: true });
    let buffer = "";
    let outcome: { ok: boolean; error?: string } | null = null;
    const timer = setTimeout(() => {
      outcome = { ok: false, error: "staging took too long" };
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = parseStageLine(buffer.slice(0, nl).trim());
        buffer = buffer.slice(nl + 1);
        if (line?.phase === "staging") onProgress(line.pct);
        else if (line?.phase === "staged") outcome = { ok: true };
        else if (line?.phase === "error") outcome = { ok: false, error: line.hresult ? `${line.message} (${line.hresult})` : line.message };
      }
    });
    child.stderr.resume();
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(outcome ?? (code === 0 ? { ok: true } : { ok: false, error: `the helper exited with ${code ?? "no code"}` }));
    });
  });
}

/** The helper's verdict on the last update, read once at start (the file is removed so it's reported once). */
export function readResult(dir: string): UpdateResult | null {
  const file = resultFile(dir);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as UpdateResult;
    return typeof value.ok === "boolean" ? value : null;
  } catch {
    return null;
  } finally {
    rmSync(file, { force: true });
  }
}

/** What the start says about an update that didn't finish (null when it did). */
export function resultMessage(result: UpdateResult | null, running: string): string | null {
  if (!result || result.ok) return null;
  const why = (result.message || "").trim().replace(/\s+/g, " ").slice(0, 300).replace(/[.\s]+$/, "");
  return `The update to ${result.to || "the new version"} didn't finish${why ? `: ${why}` : ""}. You're still on ${running}; nothing was changed.`;
}

/** Announces this start to a waiting helper: it closes its window once the reopened app's window is up. */
export function markReady(dir: string, version: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(readyFile(dir, version), new Date().toISOString());
  } catch {
    /* no helper waits on a read-only or missing folder */
  }
}

export type HandOffDeps = {
  dir: string;
  helper: () => string | null;
  /** The job without the bookkeeping paths and the face (filled in here). */
  job: Omit<HelperJob, "shownFile" | "resultFile" | "readyDir" | "facePng">;
  /** Chief's face as a PNG (its own colour and shape), written to the given path; false when it couldn't be. */
  writeFace: (target: string) => Promise<boolean>;
  launch: (commandLine: string, show: boolean) => Promise<{ ok: true; pid: number } | { ok: false; error: string }>;
  /** The fallback installer's command line (install-package.ts). */
  fallback: () => string;
  kill: (pid: number) => void;
  /** The app quits now (the helper or the installer takes over). */
  quit: () => void;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** How long the helper's window may take to appear before the fallback runs instead. */
  shownWithinMs?: number;
};

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Hand the restart to the helper's window; if it doesn't show within 10 s (blocked, or failed to start), stop it and
 * run the hidden fallback installer instead. Two installers never run at once.
 */
export async function handOff(deps: HandOffDeps): Promise<HandOffResult> {
  const sleep = deps.sleep ?? pause;
  mkdirSync(deps.dir, { recursive: true });
  const job: HelperJob = {
    ...deps.job,
    facePng: null,
    shownFile: shownFile(deps.dir, deps.job.to),
    resultFile: resultFile(deps.dir),
    readyDir: deps.dir,
  };
  for (const stale of [job.shownFile, readyFile(deps.dir, job.to), readyFile(deps.dir, job.from), job.resultFile]) rmSync(stale, { force: true });
  const face = path.join(deps.dir, "face.png");
  job.facePng = (await deps.writeFace(face).catch(() => false)) ? face : null;
  const jobPath = path.join(deps.dir, `job-${job.to}.json`);
  writeFileSync(jobPath, JSON.stringify(job, null, 2));

  const helper = deps.helper();
  if (helper) {
    const started = await deps.launch(`"${helper}" apply --job "${jobPath}"`, true);
    if (started.ok) {
      const until = Date.now() + (deps.shownWithinMs ?? 10_000);
      while (Date.now() < until) {
        if (existsSync(job.shownFile)) {
          deps.log(`handed over to the update helper (${job.from} -> ${job.to})`);
          deps.quit();
          return { ok: true, via: "helper" };
        }
        await sleep(100);
      }
      deps.kill(started.pid);
      deps.log(`the update helper didn't show its window within ${Math.round((deps.shownWithinMs ?? 10_000) / 1000)} s; using the fallback installer`);
    } else deps.log(`the update helper didn't start (${started.error}); using the fallback installer`);
  } else deps.log("no update helper in this build; using the fallback installer");

  const fallback = await deps.launch(deps.fallback(), false);
  if (!fallback.ok) {
    deps.log(`the installer didn't start (${fallback.error})`);
    return { ok: false, error: "Windows didn't start the installer. Chief is running again; try the update later." };
  }
  deps.quit();
  return { ok: true, via: "fallback" };
}
