import { spawn } from "node:child_process";

/**
 * Run a bundled Python tool that answers with one JSON object on its last line of output (provisioning, the
 * backup engine). Resolves with that answer, or with `{ ok: false, error }` when it couldn't start or answered
 * nothing readable; never rejects, never shows a traceback.
 *
 * Its stderr is always read, line by line (`onLine` gets each): a pipe nobody drains fills up, and the tool then
 * blocks on its next write forever. The 0.1.25 backup before the first start did exactly that on a large setup:
 * it reports progress on stderr four times a second, and the app hung at "Backing up" with nothing running.
 */
export type ToolResult = { ok: boolean; error?: string; [key: string]: unknown };

export function runJsonTool(
  python: string,
  args: string[],
  opts: { env: Record<string, string>; cwd?: string; startError: string; badAnswer: string; onLine?: (line: string) => void },
): Promise<ToolResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    const child = spawn(python, ["-B", ...args], { cwd: opts.cwd, env: opts.env, windowsHide: true });
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      const lines = (err + c).split(/\r?\n/);
      err = lines.pop() ?? "";
      for (const line of lines) if (line) opts.onLine?.(line);
    });
    child.on("error", () => resolve({ ok: false, error: opts.startError }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split(/\r?\n/).pop() || "") as ToolResult);
      } catch {
        resolve({ ok: false, error: opts.badAnswer });
      }
    });
    child.stdin.end();
  });
}
