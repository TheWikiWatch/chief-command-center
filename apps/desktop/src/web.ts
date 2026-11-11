import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

import type { ProcessRecord } from "./gateway";
import { pipeToLog, rotate } from "./logger";
import type { ChildHandle } from "./supervisor";

/**
 * The dashboard's Next.js server (`output: "standalone"`), run under Electron's own Node with
 * `utilityProcess` so no separate Node is shipped. It listens on 127.0.0.1 only; the window and (through
 * Tailscale Serve, when set up) the phone reach it there.
 */
export type WebConfig = { serverJs: string; port: number; env: Record<string, string>; logFile: string };

type Utility = {
  fork: (
    modulePath: string,
    args: string[],
    options: { env: Record<string, string>; cwd: string; stdio: "pipe"; serviceName: string },
  ) => {
    pid?: number;
    stdout: NodeJS.ReadableStream | null;
    stderr: NodeJS.ReadableStream | null;
    kill: () => boolean;
    once(event: "spawn", fn: () => void): void;
    once(event: "exit", fn: (code: number) => void): void;
  };
};

export function launchWeb(utility: Utility, cfg: WebConfig, onExit: (code: number | null, pid?: number) => void): ChildHandle {
  mkdirSync(path.dirname(cfg.logFile), { recursive: true });
  rotate(cfg.logFile, 10 * 1024 * 1024);
  const log = createWriteStream(cfg.logFile, { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} starting dashboard server on ${cfg.port}\n`);
  const child = utility.fork(cfg.serverJs, [], {
    env: { ...cfg.env, PORT: String(cfg.port), HOSTNAME: "127.0.0.1", NODE_ENV: "production" },
    cwd: path.dirname(cfg.serverJs),
    stdio: "pipe",
    serviceName: "Chief dashboard server",
  });
  pipeToLog(log, [child.stdout, child.stderr]);
  let exited = false;
  // Electron knows the pid only from 'spawn' on: read straight after fork() it is undefined, and the supervisor then
  // can't tell the exit of a server it ended itself (or of a stale one) from a crash.
  let pid = child.pid;
  child.once("spawn", () => (pid = child.pid));
  const done = new Promise<void>((resolve) =>
    child.once("exit", (code) => {
      exited = true;
      log.write(`--- ${new Date().toISOString()} dashboard server exited (${code})\n`);
      onExit(code, pid);
      resolve();
    }),
  );
  return {
    get pid() {
      return pid;
    },
    stop: async () => {
      if (exited) return;
      child.kill();
      await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
    },
  };
}

/** The Electron profile folder a Chromium child process names on its command line (`--user-data-dir`), normalized; "" when it names none. */
export function userDataOf(command: string): string {
  const m = /--user-data-dir=(?:"([^"]*)"|(\S+))/.exec(command);
  const dir = m ? m[1] ?? m[2] : "";
  return dir ? path.normalize(dir).toLowerCase() : "";
}

/**
 * Dashboard servers an earlier run of this app left behind (a forced quit, a crash): Electron's Node service process
 * (what `utilityProcess` runs) of this very executable and Electron profile folder, whose parent isn't this process.
 * Only one app runs per profile folder (the single-instance lock), so such a server's app is gone. The installed app is
 * another executable, so a run from source never matches it.
 */
export function leftoverDashboards(procs: ProcessRecord[], ours: { exe: string; userData: string; pid: number }): number[] {
  const same = (a: string, b: string) => !!a && !!b && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
  return procs
    .filter((p) => p.pid !== ours.pid && p.parent !== ours.pid && same(p.path, ours.exe))
    .filter((p) => /\s--type=utility(\s|$)/.test(p.command) && /\s--utility-sub-type=node\.mojom\.NodeService(\s|$)/.test(p.command))
    .filter((p) => userDataOf(p.command) === path.normalize(ours.userData).toLowerCase())
    .map((p) => p.pid);
}

export async function webHealth(port: number, timeoutMs = 2500): Promise<{ ok: boolean; detail?: string }> {
  try {
    // A static route: it answers without the gateway (a hung gateway mustn't make the dashboard look down)
    // and without the session cookie.
    const res = await fetch(`http://127.0.0.1:${port}/api/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? { ok: true } : { ok: false, detail: `The dashboard server answered ${res.status}.` };
  } catch {
    return { ok: false, detail: "No answer yet." };
  }
}
