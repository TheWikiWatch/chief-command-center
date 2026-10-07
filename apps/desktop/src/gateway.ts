import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { rotate } from "./logger";
import type { ChildHandle } from "./supervisor";

/**
 * The chief's Hermes gateway (PLAN §4): the payload launcher in the foreground (`hermes -p chief gateway run`),
 * with an explicit HERMES_HOME, this install's own gateway lock directory (unless adopted), the bridge port
 * and token, and HERMES_BIN pointing at the payload launcher.
 *
 * Stopping NEVER uses `hermes gateway stop`: on Windows it ends the per-user scheduled task named after the
 * profile (`Hermes_Gateway_chief`) and sweeps gateway processes without regard to HERMES_HOME, so it can stop
 * another install's gateway on the same PC (it did, on 2026-09-30). Instead the app writes Hermes's own
 * planned-stop marker in THIS profile's home for THIS gateway's pid (the gateway drains and exits), waits
 * 25 s, and then ends only its own process tree.
 */
export type GatewayConfig = {
  launcher: string;
  python: string;
  pythonPath: string[];
  hermesRoot: string;
  profile: string;
  env: Record<string, string>;
  logFile: string;
};

export function profileHome(hermesRoot: string, profile = "chief"): string {
  return path.join(hermesRoot, "profiles", profile);
}

function logStream(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  rotate(file, 10 * 1024 * 1024);
  return createWriteStream(file, { flags: "a" });
}

/** Run a helper process to its end without blocking the main thread; resolves with its exit code (null on a timeout or a launch error). */
function finished(child: ChildProcess, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/** End a process and everything it started. Never blocks the main thread (a sync wait froze the window for seconds). */
export async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await finished(spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, stdio: "ignore" }), 15_000);
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

/** Ask one gateway, in one profile home, to drain and exit (Hermes's own marker). Nothing else is touched. */
export async function requestScopedStop(cfg: Pick<GatewayConfig, "python" | "pythonPath" | "hermesRoot" | "profile" | "env">, gatewayPid: number): Promise<boolean> {
  const script = "import sys\nfrom gateway.status import write_planned_stop_marker\nsys.exit(0 if write_planned_stop_marker(int(sys.argv[1])) else 1)";
  const child = spawn(cfg.python, ["-B", "-c", script, String(gatewayPid)], {
    env: { ...cfg.env, HERMES_HOME: profileHome(cfg.hermesRoot, cfg.profile), PYTHONPATH: cfg.pythonPath.join(";") },
    windowsHide: true,
    stdio: "ignore",
  });
  return (await finished(child, 20_000)) === 0;
}

/**
 * A gateway launched by this app that no supervisor of this run owns: left behind by a crashed run, and ended before
 * ours starts. One that this run's supervisor is starting or running is ours and alive: Retry after a failed start used
 * to find exactly that in the pid file and kill it.
 */
export function isOrphan(owner: GatewayOwner, supervisor: { state: string; child: { pid?: number } | null } | undefined): boolean {
  if (owner.state !== "ours") return false;
  if (!supervisor) return true;
  return !(supervisor.child && (supervisor.state === "running" || supervisor.state === "starting"));
}

/** The gateway's own pid (the Python process), from this profile's pid file. */
export function profileGatewayPid(hermesRoot: string, profile = "chief"): number {
  try {
    const text = readFileSync(path.join(profileHome(hermesRoot, profile), "gateway.pid"), "utf8").trim();
    return Number((text.startsWith("{") ? JSON.parse(text).pid : text) || 0);
  } catch {
    return 0;
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
        // The pid file appears a few seconds after the bridge answers; the marker watcher may start later still.
        let gatewayPid = 0;
        for (let i = 0; i < 30 && !gatewayPid && child.exitCode === null; i++) {
          gatewayPid = profileGatewayPid(cfg.hermesRoot, cfg.profile);
          if (!gatewayPid) await new Promise((r) => setTimeout(r, 1000));
        }
        for (let attempt = 0; attempt < 2 && gatewayPid && child.exitCode === null; attempt++) {
          if ((await requestScopedStop(cfg, gatewayPid)) && (await waitExit(child, attempt ? 15_000 : 12_000))) return;
        }
      }
      if (pid) await killTree(pid);
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
