import { describe, expect, it } from "vitest";

import { runJsonTool } from "../src/python";

const python = process.env.CHIEF_TEST_PYTHON || "python";
const opts = { env: { ...process.env } as Record<string, string>, startError: "no python", badAnswer: "bad answer" };

describe("runJsonTool", () => {
  it("returns the tool's last JSON line", async () => {
    expect(await runJsonTool(python, ["-c", "print('working'); print('{\"ok\": true, \"n\": 2}')"], opts)).toEqual({ ok: true, n: 2 });
  });
  // The 0.1.25 backup before the first start hung on a large setup: it reports progress on stderr, nobody read
  // it, the pipe filled and the tool blocked on its next write forever.
  it("reads stderr as it comes, so a chatty tool never blocks, and hands each line on", async () => {
    const lines: string[] = [];
    const script = "import sys\nfor i in range(40000): sys.stderr.write('{\"progress\": [%d, 40000]}\\n' % i)\nprint('{\"ok\": true}')";
    const result = await runJsonTool(python, ["-c", script], { ...opts, onLine: (l) => lines.push(l) });
    expect(result).toEqual({ ok: true });
    expect(lines.length).toBe(40000);
    expect(lines[39999]).toBe('{"progress": [39999, 40000]}');
  }, 30_000);

  it("turns a crash or a missing Python into a plain error", async () => {
    expect(await runJsonTool(python, ["-c", "raise SystemExit('boom')"], opts)).toEqual({ ok: false, error: "bad answer" });
    expect(await runJsonTool("no-such-python-here", [], opts)).toEqual({ ok: false, error: "no python" });
  });

  // Security review S3: a .pth or usercustomize.py in the per-user site-packages ran inside provisioning and backups.
  it("starts Python without the per-user site-packages", async () => {
    const script = "import json, site, sys\nprint(json.dumps({'ok': True, 'flag': sys.flags.no_user_site, 'enabled': site.ENABLE_USER_SITE}))";
    expect(await runJsonTool(python, ["-c", script], opts)).toEqual({ ok: true, flag: 1, enabled: false });
  });

  it("ends a tool that stops answering, with everything it started, and fails the step", async () => {
    // A hung provisioning or restore recovery used to keep its step spinning forever.
    const script = [
      "import subprocess, sys, time",
      "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])",
      "sys.stderr.write('%d\\n' % child.pid); sys.stderr.flush()",
      "time.sleep(60)",
    ].join("\n");
    const pids: number[] = [];
    const started = Date.now();
    const result = await runJsonTool(python, ["-c", script], { ...opts, idleMs: 1500, stalled: "it hung", onLine: (l) => pids.push(Number(l)) });
    expect(result).toEqual({ ok: false, error: "it hung" });
    expect(Date.now() - started).toBeLessThan(20_000);
    const gone = async (pid: number) => {
      for (let i = 0; i < 100; i++) {
        try {
          process.kill(pid, 0);
        } catch {
          return true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    };
    expect(pids).toHaveLength(1);
    expect(await gone(pids[0])).toBe(true);
  }, 30_000);

  it("a tool that keeps reporting is never cut off, however long it runs", async () => {
    const script = "import sys, time\nfor i in range(12):\n    sys.stderr.write('step\\n'); sys.stderr.flush(); time.sleep(0.1)\nprint('{\"ok\": true}')";
    expect(await runJsonTool(python, ["-c", script], { ...opts, idleMs: 600 })).toEqual({ ok: true });
  }, 30_000);
});
