import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { fallbackCommandLine, installScript, wmiLaunchScript } from "../src/install-package";

const parsesAsPowerShell = (script: string) => {
  const check = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`;
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", check], { input: script, encoding: "utf8" });
};

describe("the fallback install script", () => {
  const script = installScript("C:\\Updates\\Chief O'Brien 1.2.3.msix", "C:\\Logs\\update-install.log", "C:\\App\\updater\\update-result.json", "1.2.2", "1.2.3");

  it("installs onto the drive Chief is already on, and always brings Chief back", () => {
    expect(script).toContain("Get-AppxVolume");
    expect(script).toContain("$extra.Volume = $vol");
    expect(script).toContain("-ForceUpdateFromAnyVersion -ErrorAction Stop @extra");
    expect(script).toContain("'C:\\Updates\\Chief O''Brien 1.2.3.msix'"); // quotes in the path are escaped
    expect(script.indexOf("finally")).toBeLessThan(script.indexOf("Start-Process"));
  });

  it("writes the same result file as the helper, so the next start can say how it went", () => {
    expect(script).toContain("Set-Content -Path 'C:\\App\\updater\\update-result.json'");
    expect(script).toContain("ok = $true");
    expect(script).toContain("ok = $false");
    expect(script).toContain("via = 'fallback'");
  });

  it("runs with no window at all: headless conhost, hidden PowerShell, encoded command", () => {
    const line = fallbackCommandLine(script);
    expect(line.startsWith("conhost.exe --headless powershell.exe ")).toBe(true);
    expect(line).toContain("-WindowStyle Hidden -EncodedCommand ");
    const encoded = line.split("-EncodedCommand ")[1];
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(script);
  });

  it.runIf(process.platform === "win32")("is valid PowerShell", () => {
    const r = parsesAsPowerShell(script);
    expect(r.stdout.trim()).toBe("");
    expect(r.status).toBe(0);
  }, 60_000);
});

describe("starting a process through WMI", () => {
  it("sets the window state explicitly: shown for the helper's popup, hidden for the installer", () => {
    expect(wmiLaunchScript('"C:\\x\\ChiefUpdater.exe" apply --job "C:\\x\\job.json"', true)).toContain("ShowWindow = [uint16]1");
    expect(wmiLaunchScript("conhost.exe --headless powershell.exe", false)).toContain("ShowWindow = [uint16]0");
  });

  it("fails loudly when WMI reports a failure, and prints the new process id", () => {
    const script = wmiLaunchScript("x.exe", true);
    expect(script).toContain("if ($r.ReturnValue -ne 0) { exit 3 }");
    expect(script).toContain("ProcessStartupInformation = $si");
    expect(script).toContain("$r.ProcessId");
  });

  it("escapes quotes in the command line", () => {
    expect(wmiLaunchScript("C:\\O'Brien\\x.exe", true)).toContain("CommandLine = 'C:\\O''Brien\\x.exe'");
  });

  it.runIf(process.platform === "win32")("is valid PowerShell", () => {
    const r = parsesAsPowerShell(wmiLaunchScript('"C:\\x\\ChiefUpdater.exe" apply --job "C:\\x\\job.json"', true));
    expect(r.stdout.trim()).toBe("");
    expect(r.status).toBe(0);
  }, 60_000);
});
