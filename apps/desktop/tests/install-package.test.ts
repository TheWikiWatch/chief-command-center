import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { fallbackCommandLine, installScript, wmiLaunchScript } from "../src/install-package";

const parsesAsPowerShell = (script: string) => {
  const check = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }`;
  return spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", check], { input: script, encoding: "utf8" });
};

describe("the fallback install script", () => {
  const SHA = "ab".repeat(32);
  const script = installScript("C:\\Updates\\Chief O'Brien 1.2.3.msix", "C:\\Logs\\update-install.log", "C:\\App\\updater\\update-result.json", "1.2.2", "1.2.3", SHA);

  it("installs onto the drive Chief is already on, and always brings Chief back", () => {
    expect(script).toContain("Get-AppxVolume");
    expect(script).toContain("$extra.Volume = $vol");
    expect(script).toContain("-ForceApplicationShutdown -ErrorAction Stop @extra");
    expect(script).toContain("'C:\\Updates\\Chief O''Brien 1.2.3.msix'"); // quotes in the path are escaped
    expect(script.indexOf("finally")).toBeLessThan(script.indexOf("Start-Process"));
  });

  it("installs only the package it checked, held open so it can't be swapped, and downgrades only when going back", () => {
    expect(script).toContain("[System.IO.File]::Open('C:\\Updates\\Chief O''Brien 1.2.3.msix', 'Open', 'Read', 'Read')");
    expect(script).toContain(`if ($h -ne '${SHA}')`);
    expect(script.indexOf("ComputeHash")).toBeLessThan(script.indexOf("Add-AppxPackage"));
    expect(script).not.toContain("-ForceUpdateFromAnyVersion");
    expect(installScript("C:\\u\\a.msix", "C:\\l.log", "", "1.2.3", "1.2.2", SHA, true)).toContain("-ForceUpdateFromAnyVersion");
    // No hash given: nothing matches, so nothing installs.
    expect(installScript("C:\\u\\a.msix", "C:\\l.log")).toContain("if ($h -ne 'missing')");
  });

  it("writes the same result file as the helper, so the next start can say how it went", () => {
    expect(script).toContain("Set-Content -Path 'C:\\App\\updater\\update-result.json'");
    expect(script).toContain("ok = $true");
    expect(script).toContain("ok = $false");
    expect(script).toContain("via = 'fallback'");
  });

  it("runs with no window at all: headless conhost, hidden PowerShell, encoded command", () => {
    const line = fallbackCommandLine(script);
    expect(line).toMatch(/^"[A-Z]:\\Windows\\System32\\conhost\.exe" --headless "[A-Z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" /i);
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
