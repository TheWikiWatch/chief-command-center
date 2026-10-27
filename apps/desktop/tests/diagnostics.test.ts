import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { collect, createDiagnostics, LOG_TAIL_BYTES, readTail } from "../src/diagnostics";
import { Logger } from "../src/logger";

const tmp = mkdtempSync(path.join(tmpdir(), "chief-diag-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("the diagnostics bundle", () => {
  const logs = path.join(tmp, "logs");
  const dumps = path.join(tmp, "dumps");
  mkdirSync(logs, { recursive: true });
  mkdirSync(dumps, { recursive: true });
  writeFileSync(path.join(logs, "main.jsonl"), '{"event":"x","auth":"Bearer abcdefghijklmnopqrst"}\n');
  writeFileSync(path.join(logs, "gateway.log"), "started\n");
  writeFileSync(path.join(logs, "notes.txt"), "not a log\n");
  writeFileSync(path.join(dumps, "crash.dmp"), Buffer.from([1, 2, 3]));
  const redact = (text: string) => new Logger(() => tmp).redact(text);
  const sources = [
    { dir: logs, prefix: "logs", pattern: /\.(log|jsonl)(\.\d+)?$/, text: true },
    { dir: dumps, prefix: "crashes", pattern: /\.dmp$/, text: false },
    { dir: path.join(tmp, "absent"), prefix: "bridge", pattern: /./, text: true },
  ];

  it("takes logs (redacted) and crash dumps, and nothing else", async () => {
    const staging = path.join(tmp, "staging");
    const files = await collect(sources, staging, redact);
    expect(files.sort()).toEqual(["crashes/crash.dmp", "logs/gateway.log", "logs/main.jsonl"]);
    expect(readFileSync(path.join(staging, "logs", "main.jsonl"), "utf8")).toContain("Bearer [redacted]");
  });

  it("takes only the newest part of a long log, from a whole line on", async () => {
    // Before: whole logs (up to 20 MB each) were read and redacted at once on the main thread, freezing the window.
    const big = path.join(tmp, "big.log");
    const line = "x".repeat(99) + "\n";
    writeFileSync(big, `${"first line\n"}${line.repeat(Math.ceil((LOG_TAIL_BYTES * 1.5) / line.length))}last line\n`);
    const tail = await readTail(big);
    expect(tail.length).toBeLessThanOrEqual(LOG_TAIL_BYTES);
    expect(tail.startsWith("x".repeat(99))).toBe(true); // no half line at the top
    expect(tail).not.toContain("first line");
    expect(tail.endsWith("last line\n")).toBe(true);
    expect(await readTail(path.join(logs, "gateway.log"))).toBe("started\n"); // a short log, whole
  });

  // Zipping goes through Windows' own tools, which took 18 s on a GitHub runner (under a second here).
  it.runIf(process.platform === "win32")("zips them with an about file", async () => {
    const out = path.join(tmp, "diag.zip");
    const r = await createDiagnostics({ sources, info: { app: "1.2.3" }, redact, out });
    expect(r.ok).toBe(true);
    expect(existsSync(out)).toBe(true);
  }, 60_000);
});
