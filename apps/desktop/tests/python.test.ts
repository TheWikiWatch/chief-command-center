import { describe, expect, it } from "vitest";

import { runJsonTool } from "../src/python";

const python = process.env.CHIEF_TEST_PYTHON || "python";
const opts = { env: { ...process.env } as Record<string, string>, startError: "no python", badAnswer: "bad answer" };

describe("runJsonTool", () => {
  it("returns the tool's last JSON line", async () => {
    expect(await runJsonTool(python, ["-c", "print('working'); print('{\"ok\": true, \"n\": 2}')"], opts)).toEqual({ ok: true, n: 2 });
  });
  it("turns a crash or a missing Python into a plain error", async () => {
    expect(await runJsonTool(python, ["-c", "raise SystemExit('boom')"], opts)).toEqual({ ok: false, error: "bad answer" });
    expect(await runJsonTool("no-such-python-here", [], opts)).toEqual({ ok: false, error: "no python" });
  });
});
