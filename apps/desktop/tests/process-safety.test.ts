import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { stillTheGateway } from "../src/gateway";
import { systemCwd, systemTool } from "../src/guards";

/* Security review, low items: Windows tools by absolute path; an orphan is ended only while it's still the gateway. */

const root = mkdtempSync(path.join(tmpdir(), "chief-orphan-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Windows tools", () => {
  it("come from System32 by absolute path, never from PATH or the working folder", () => {
    const env = { SystemRoot: "C:\\Windows" };
    expect(systemTool("powershell", env)).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(systemTool("taskkill", env)).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(systemCwd(env)).toBe("C:\\Windows\\System32");
  });
});

describe("orphan cleanup", () => {
  const home = path.join(root, "profiles", "chief");
  mkdirSync(home, { recursive: true });
  const pidFile = path.join(home, "gateway.pid");
  writeFileSync(pidFile, JSON.stringify({ pid: 4242 }));
  const written = new Date("2026-10-13T10:00:00Z");
  utimesSync(pidFile, written, written);
  const at = (iso: string) => Date.parse(iso);

  it("ends only a Python or Hermes process that started before the pid file was written", async () => {
    const ask = (p: string, started: string) => stillTheGateway(4242, root, "chief", async () => ({ path: p, startedMs: at(started) }));
    expect(await ask("E:\\payload\\venv\\Scripts\\python.exe", "2026-10-13T09:59:58Z")).toBe(true);
    // Windows gave the pid to something else since (a later start, or another program).
    expect(await ask("E:\\payload\\venv\\Scripts\\python.exe", "2026-10-13T12:00:00Z")).toBe(false);
    expect(await ask("C:\\Program Files\\Editor\\editor.exe", "2026-10-13T09:00:00Z")).toBe(false);
    expect(await stillTheGateway(4242, root, "chief", async () => null)).toBe(false);
    expect(await stillTheGateway(4242, path.join(root, "nowhere"), "chief", async () => ({ path: "python.exe", startedMs: 0 }))).toBe(false);
  });
});
