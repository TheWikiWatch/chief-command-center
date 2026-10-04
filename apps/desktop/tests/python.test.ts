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
});
