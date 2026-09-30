import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";

import type { ChildHandle } from "./supervisor";

/**
 * The chief's Hermes gateway (PLAN §4): the payload launcher in the foreground (`hermes -p chief gateway run`),
 * with an explicit HERMES_HOME, this install's own gateway lock directory (unless adopted), the bridge port
 * and token, and HERMES_BIN pointing at the payload launcher. Stopping asks Hermes first (`gateway stop`,
 * 25 s) and only then ends the process tree.
 */
export type GatewayConfig = { launcher: string; hermesRoot: string; profile: string; env: Record<string, string>; logFile: string };

export function profileHome(hermesRoot: string, profile = "chief"): string {
  return path.join(hermesRoot, "profiles", profile);
}

function logStream(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (statSync(file).size > 10 * 1024 * 1024) renameSync(file, `${file}.1`);
  } catch {
    /* no log yet */
  }
  return createWriteStream(file, { flags: "a" });
}

export function killTree(pid: number) {
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true });
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

function waitExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export function launchGateway(cfg: GatewayConfig, onExit: (code: number | null, pid?: number) => void): ChildHandle & { process: ChildProcess } {
  const log = logStream(cfg.logFile);
  log.write(`\n--- ${new Date().toISOString()} starting gateway\n`);
  const child = spawn(cfg.launcher, ["-p", cfg.profile, "gateway", "run"], {
    env: cfg.env,
    cwd: profileHome(cfg.hermesRoot, cfg.profile),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const pid = child.pid;
  child.once("exit", (code) => {
    log.write(`--- ${new Date().toISOString()} gateway exited (${code})\n`);
    onExit(code, pid);
  });
  child.once("error", () => onExit(null, pid));
  return {
    pid,
    process: child,
    stop: async (graceful: boolean) => {
      if (graceful) {
        spawn(cfg.launcher, ["-p", cfg.profile, "gateway", "stop"], { env: cfg.env, windowsHide: true, stdio: "ignore" });
        if (await waitExit(child, 25_000)) return;
      }
      if (pid) killTree(pid);
      await waitExit(child, 5_000);
    },
  };
}

export type GatewayOwner = { state: "none" } | { state: "ours"; pid: number } | { state: "foreign"; pid: number; launcher: string };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Who is running this profile's gateway right now, from Hermes's own pid file. */
export function gatewayOwner(hermesRoot: string, ourLauncher: string, profile = "chief", isAlive: (pid: number) => boolean = alive): GatewayOwner {
  const file = path.join(profileHome(hermesRoot, profile), "gateway.pid");
  if (!existsSync(file)) return { state: "none" };
  let info: { pid?: number; argv?: string[] };
  try {
    const text = readFileSync(file, "utf8").trim();
    info = text.startsWith("{") ? JSON.parse(text) : { pid: Number(text) };
  } catch {
    return { state: "none" };
  }
  const pid = Number(info.pid || 0);
  if (!pid || !isAlive(pid)) return { state: "none" };
  const launcher = String(info.argv?.[0] || "");
  const same = launcher && path.normalize(launcher).toLowerCase() === path.normalize(ourLauncher).toLowerCase();
  return same ? { state: "ours", pid } : { state: "foreign", pid, launcher };
}

export async function bridgeHealth(port: number, token: string, timeoutMs = 2500): Promise<{ ok: boolean; voice?: boolean; detail?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401) return { ok: false, detail: "The gateway answered but refused this app's token." };
    const body = (await res.json()) as { ok?: boolean; profile?: string; voice?: boolean };
    if (!body.ok) return { ok: false, detail: "The gateway isn't ready." };
    if (body.profile !== "chief") return { ok: false, detail: `Port ${port} is answered by something else.` };
    return { ok: true, voice: !!body.voice };
  } catch {
    return { ok: false, detail: "No answer yet." };
  }
}

export async function waitFor<T>(probe: () => Promise<T & { ok: boolean }>, ms: number, every = 500): Promise<T & { ok: boolean }> {
  const end = Date.now() + ms;
  let last = await probe();
  while (!last.ok && Date.now() < end) {
    await new Promise((r) => setTimeout(r, every));
    last = await probe();
  }
  return last;
}
