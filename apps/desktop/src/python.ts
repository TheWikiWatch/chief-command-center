import { spawn } from "node:child_process";

import { killTree } from "./gateway";

/**
 * Run a bundled Python tool that answers with one JSON object on its last line of output (provisioning, the
 * backup engine). Resolves with that answer, or with `{ ok: false, error }` when it couldn't start or answered
 * nothing readable; never rejects, never shows a traceback.
 *
 * Its stderr is always read, line by line (`onLine` gets each): a pipe nobody drains fills up, and the tool then
 * blocks on its next write forever. The 0.1.25 backup before the first start did exactly that on a large setup:
 * it reports progress on stderr four times a second, and the app hung at "Backing up" with nothing running.
 *
 * A tool that says nothing for `idleMs` (a hung provisioning or restore recovery) is ended with everything it started,
 * and the step fails instead of spinning forever.
 */
export type ToolResult = { ok: boolean; error?: string; [key: string]: unknown };

/** How long a tool may go without a word: provisioning prints only its answer, and a backup's largest file can take minutes between progress lines. */
export const IDLE_MS = 10 * 60_000;

export function runJsonTool(
  python: string,
  args: string[],
  opts: { env: Record<string, string>; cwd?: string; startError: string; badAnswer: string; stalled?: string; idleMs?: number; onLine?: (line: string) => void },
): Promise<ToolResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    // -P: the script's folder and the working folder are never put ahead of the payload's own modules. -s: nor is the
    // per-user site-packages, where a planted .pth or usercustomize.py would run inside every one of these tools.
    const child = spawn(python, ["-B", "-P", "-s", ...args], { cwd: opts.cwd, env: opts.env, windowsHide: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const heard = () => {
      clearTimeout(idle);
      if (ended) return;
      idle = setTimeout(() => {
        ended = true;
        resolve({ ok: false, error: opts.stalled ?? "The tool stopped responding, so it was ended." });
        if (child.pid) void killTree(child.pid);
      }, opts.idleMs ?? IDLE_MS);
    };
    heard();
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      out += c;
      heard();
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      heard();
      const lines = (err + c).split(/\r?\n/);
      err = lines.pop() ?? "";
      for (const line of lines) if (line) opts.onLine?.(line);
    });
    child.on("error", () => {
      clearTimeout(idle);
      resolve({ ok: false, error: opts.startError });
    });
    child.on("close", () => {
      clearTimeout(idle);
      try {
        resolve(JSON.parse(out.trim().split(/\r?\n/).pop() || "") as ToolResult);
      } catch {
        resolve({ ok: false, error: opts.badAnswer });
      }
    });
    child.stdin.end();
  });
}
