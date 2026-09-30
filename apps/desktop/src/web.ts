import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

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
    once: (event: "exit", fn: (code: number) => void) => void;
  };
};

export function launchWeb(utility: Utility, cfg: WebConfig, onExit: (code: number | null, pid?: number) => void): ChildHandle {
  mkdirSync(path.dirname(cfg.logFile), { recursive: true });
  const log = createWriteStream(cfg.logFile, { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} starting dashboard server on ${cfg.port}\n`);
  const child = utility.fork(cfg.serverJs, [], {
    env: { ...cfg.env, PORT: String(cfg.port), HOSTNAME: "127.0.0.1", NODE_ENV: "production" },
    cwd: path.dirname(cfg.serverJs),
    stdio: "pipe",
    serviceName: "Chief dashboard server",
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  let exited = false;
  const pid = child.pid;
  const done = new Promise<void>((resolve) =>
    child.once("exit", (code) => {
      exited = true;
      log.write(`--- ${new Date().toISOString()} dashboard server exited (${code})\n`);
      onExit(code, pid);
      resolve();
    }),
  );
  return {
    pid,
    stop: async () => {
      if (exited) return;
      child.kill();
      await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
    },
  };
}

export async function webHealth(port: number, timeoutMs = 2500): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/app/config`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? { ok: true } : { ok: false, detail: `The dashboard server answered ${res.status}.` };
  } catch {
    return { ok: false, detail: "No answer yet." };
  }
}
