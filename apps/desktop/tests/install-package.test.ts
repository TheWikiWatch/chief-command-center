import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false, exit: () => undefined } }));
vi.mock("../src/runtime", () => ({ logLine: () => undefined }));
vi.mock("../src/state", () => ({ ctx: {}, log: { info: () => undefined, error: () => undefined } }));

const { installScript } = await import("../src/install-package");

describe("the update install script", () => {
  const script = installScript("C:\\Updates\\Chief O'Brien 1.2.3.msix", "C:\\Logs\\update-install.log");

  it("installs onto the drive Chief is already on, and always brings Chief back", () => {
    expect(script).toContain("Get-AppxVolume");
    expect(script).toContain("$extra.Volume = $vol");
    expect(script).toContain("-ForceUpdateFromAnyVersion -ErrorAction Stop @extra");
    expect(script).toContain("'C:\\Updates\\Chief O''Brien 1.2.3.msix'"); // quotes in the path are escaped
    expect(script.indexOf("finally")).toBeLessThan(script.indexOf("Start-Process"));
  });

  it.runIf(process.platform === "win32")("is valid PowerShell", () => {
    const check = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", check], { input: script, encoding: "utf8" });
    expect(r.stdout.trim()).toBe("");
    expect(r.status).toBe(0);
  }, 60_000);
});
