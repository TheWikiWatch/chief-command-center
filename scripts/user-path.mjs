// Hermes adds its home's `bin` folder to the Windows user PATH whenever it sets up its commands
// (hermes_cli/_launchers.py `_expose_windows_user_bin`), throwaway homes included. A test run takes its own entries out
// again afterwards, so they don't pile up until PATH is too long for cmd.exe (about 90 of them did, 2026-10-13).
import { spawnSync } from "node:child_process";
import path from "node:path";

const SCRIPT = [
  "$under = [IO.Path]::GetFullPath($env:CHIEF_DROP_UNDER).TrimEnd('\\') + '\\'",
  "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
  "if (-not $key) { exit 0 }",
  "$raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')",
  "if (-not $raw) { exit 0 }",
  "$kind = $key.GetValueKind('Path')",
  "$parts = $raw -split ';' | Where-Object { $_ -ne '' }",
  "$keep = @($parts | Where-Object { -not ([Environment]::ExpandEnvironmentVariables($_).TrimEnd('\\') + '\\').StartsWith($under, 'OrdinalIgnoreCase') })",
  "if ($keep.Count -ne $parts.Count) { $key.SetValue('Path', ($keep -join ';'), $kind) }",
  "[Console]::Out.Write($parts.Count - $keep.Count)",
].join("; ");

/** Remove every user PATH entry inside `dir` (Windows only); returns how many went. Never throws. */
export function dropUserPathUnder(dir) {
  if (process.platform !== "win32" || !dir) return 0;
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const r = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
    env: { ...process.env, CHIEF_DROP_UNDER: path.resolve(dir) },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  return Number.parseInt(String(r.stdout || "0"), 10) || 0;
}
