import { spawn } from "node:child_process";

/**
 * Run a bundled Python tool that answers with one JSON object on its last line of output (provisioning, the
 * backup engine). Resolves with that answer, or with `{ ok: false, error }` when it couldn't start or answered
 * nothing readable; never rejects, never shows a traceback.
 */
export type ToolResult = { ok: boolean; error?: string; [key: string]: unknown };

export function runJsonTool(
  python: string,
  args: string[],
  opts: { env: Record<string, string>; cwd?: string; startError: string; badAnswer: string },
): Promise<ToolResult> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(python, ["-B", ...args], { cwd: opts.cwd, env: opts.env, windowsHide: true });
    child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
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
