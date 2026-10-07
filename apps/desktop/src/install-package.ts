import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Starting installers outside the app. Windows shuts the package's processes down to replace it
 * (ForceApplicationShutdown), so anything that must outlive the app is started by WMI (`Win32_Process.Create`): its
 * parent is WMI's host, not the app, so it has no package identity and isn't in the app's job.
 *
 * The update helper (ChiefUpdater.exe, update-helper.ts) is the normal path. The hidden PowerShell installer below is
 * the fallback for a PC where the helper can't run (Smart App Control or an antivirus blocking a copied exe).
 */

/**
 * The PowerShell that starts a command through WMI with a window state (`show`: SW_SHOWNORMAL for the helper's popup;
 * SW_HIDE for the fallback installer, whose console must never appear). Prints the new process id; exits 3 when WMI
 * reports a failure, which it does in ReturnValue rather than as an error.
 */
export function wmiLaunchScript(commandLine: string, show: boolean): string {
  const cmd = commandLine.replace(/'/g, "''");
  return [
    `$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]${show ? 1 : 0} }`,
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmd}'; ProcessStartupInformation = $si }`,
    "if ($r.ReturnValue -ne 0) { exit 3 }",
    "[Console]::Out.Write([string]$r.ProcessId)",
  ].join("; ");
}

/** Runs `wmiLaunchScript` in a hidden PowerShell without blocking the app; resolves the started process's id. */
export function launchDetached(commandLine: string, show: boolean, timeoutMs = 30_000): Promise<{ ok: true; pid: number } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", wmiLaunchScript(commandLine, show)], { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const pid = Number.parseInt(out.trim(), 10);
      resolve(code === 0 && pid > 0 ? { ok: true, pid } : { ok: false, error: `exit ${code ?? "none"}${err.trim() ? `: ${err.trim().slice(-300)}` : ""}` });
    });
  });
}

/**
 * The fallback installer: Windows installs the verified package (checking its signature again) and the app is
 * relaunched whatever happened. It writes the same result file as the helper, so the next start can say how it went.
 */
export function installScript(file: string, logFile: string, resultFile = "", from = "", to = ""): string {
  const log = logFile.replace(/'/g, "''");
  const result = resultFile.replace(/'/g, "''");
  const writeResult = (ok: boolean, message: string) =>
    result
      ? `  Set-Content -Path '${result}' -Encoding UTF8 -Value (ConvertTo-Json -Compress @{ version = 1; ok = $${ok}; from = '${from}'; to = '${to}'; step = 'add'; message = ${message}; hresult = ''; finishedAt = (Get-Date).ToUniversalTime().ToString('o'); via = 'fallback' })`
      : "";
  return [
    `function Note($t) { Add-Content -Path '${log}' -Value ("$(Get-Date -Format s) " + $t) }`,
    `Note 'installing ${path.basename(file).replace(/'/g, "''")} (fallback installer)'`,
    "try {",
    // An update stays on the drive Chief was installed on (the installer can put it on another one): Windows
    // otherwise stages it on its default app drive.
    "  $loc = [string](Get-AppxPackage -Name ChiefCommandCenter).InstallLocation",
    "  $vol = $null",
    "  if ($loc) { $vol = Get-AppxVolume | Where-Object { $loc.ToUpperInvariant().StartsWith(([string]$_.PackageStorePath).ToUpperInvariant() + '\\') } | Select-Object -First 1 }",
    "  $extra = @{}",
    "  if ($vol) { $extra.Volume = $vol }",
    `  Add-AppxPackage -Path '${file.replace(/'/g, "''")}' -ForceApplicationShutdown -ForceUpdateFromAnyVersion -ErrorAction Stop @extra`,
    "  Note ('installed ' + (Get-AppxPackage -Name ChiefCommandCenter).Version)",
    writeResult(true, "''"),
    "} catch {",
    "  Note ('install failed: ' + $_.Exception.Message)",
    writeResult(false, "[string]$_.Exception.Message"),
    "} finally {",
    // The app always comes back, updated or not, so Chief is never left stopped.
    "  $p = Get-AppxPackage -Name ChiefCommandCenter",
    "  Start-Process ('shell:AppsFolder\\' + $p.PackageFamilyName + '!ChiefCommandCenter')",
    "}",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * The command line that runs the fallback installer with no window at all: conhost in headless mode hosts the
 * console (so Windows Terminal, the default console on Windows 11, never opens one), and PowerShell hides itself too.
 * -EncodedCommand (UTF-16LE base64) avoids every command-line quoting pitfall.
 */
export function fallbackCommandLine(script: string): string {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `conhost.exe --headless powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}`;
}
