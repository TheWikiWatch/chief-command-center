import path from "node:path";
import { spawnSync } from "node:child_process";

import { app } from "electron";

import { logLine } from "./runtime";
import { ctx, log } from "./state";

/**
 * Windows installs the verified package (its signature is checked again by Windows) and relaunches the app.
 * The PowerShell that installs it is started by WMI, outside the app: Windows shuts the app's processes down to
 * replace the package (-ForceApplicationShutdown), and a child of the app would be stopped halfway through.
 */
export function installScript(file: string, logFile: string): string {
  const log = logFile.replace(/'/g, "''");
  return [
    `function Note($t) { Add-Content -Path '${log}' -Value ("$(Get-Date -Format s) " + $t) }`,
    `Note 'installing ${path.basename(file).replace(/'/g, "''")}'`,
    "try {",
    `  Add-AppxPackage -Path '${file.replace(/'/g, "''")}' -ForceApplicationShutdown -ForceUpdateFromAnyVersion -ErrorAction Stop`,
    "  Note ('installed ' + (Get-AppxPackage -Name ChiefCommandCenter).Version)",
    "} catch {",
    "  Note ('install failed: ' + $_.Exception.Message)",
    "} finally {",
    // The app always comes back, updated or not, so Chief is never left stopped.
    "  $p = Get-AppxPackage -Name ChiefCommandCenter",
    "  Start-Process ('shell:AppsFolder\\' + $p.PackageFamilyName + '!ChiefCommandCenter')",
    "}",
  ].join("\n");
}

export function installPackage(file: string): Promise<{ ok: boolean; error?: string }> {
  if (!app.isPackaged) return Promise.resolve({ ok: false, error: "Updates install only in the installed app." });
  // -EncodedCommand (UTF-16LE base64) avoids every command-line quoting pitfall.
  const encoded = Buffer.from(installScript(file, path.join(ctx.paths.logs, "update-install.log")), "utf16le").toString("base64");
  // Win32_Process.Create reports failure in ReturnValue, not as an error: exit non-zero unless it is 0, or the
  // app would quit with no installer running and nothing to bring it back.
  const outer = `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}'}; if ($r.ReturnValue -ne 0) { exit 3 }`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", outer], { windowsHide: true, timeout: 30_000 });
  if (result.status !== 0) {
    logLine("update-install.log", `the installer didn't start (exit ${result.status ?? "none"})`);
    log.error("update.installer-not-started", { exit: result.status });
    return Promise.resolve({ ok: false, error: "Windows didn't start the installer. Chief is running again; try the update later." });
  }
  log.info("update.installer-started", { file: path.basename(file) });
  ctx.quitting = true;
  setTimeout(() => app.exit(0), 1500);
  return Promise.resolve({ ok: true });
}
