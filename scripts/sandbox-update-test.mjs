#!/usr/bin/env node
// A real update, end to end, in Windows Sandbox (docs/PLAN-2026-10-07 §1.5): the one part of the update flow that
// can't run on a PC whose own Chief is installed (same package identity) and that --simulate can't prove.
//
//   node scripts/sandbox-update-test.mjs --from <older .msix> --to <newer .msix> --cer <signing .cer>
//
// It writes a folder under the build folder with both packages, the certificate, the newer package's update helper
// and a script, then opens Windows Sandbox on it. Inside, the script trusts the certificate, installs the older
// version, starts it, has the helper stage the newer package (as the app does while it runs) and then run `apply`
// against it (the app's restart: close, quiet wait, register, reopen, ready). Results land in `results.txt` beside the
// script on this PC: the installed version before and after, the helper's log, update-result.json and whether the
// reopened app wrote its ready marker. Nothing touches this PC's own install.
//
// Needs Windows Sandbox (Windows 11 Pro: "Windows Sandbox" in Windows Features, then a restart).
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};
const from = opt("from");
const to = opt("to");
const cer = opt("cer");
if (!from || !to || !cer) fail("usage: node scripts/sandbox-update-test.mjs --from <older .msix> --to <newer .msix> --cer <signing .cer>");
for (const f of [from, to, cer]) if (!existsSync(f)) fail(`not found: ${f}`);
const sandbox = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsSandbox.exe");
if (!existsSync(sandbox)) fail("Windows Sandbox isn't installed: turn on \"Windows Sandbox\" in Windows Features (needs a restart), then run this again.");

const repo = path.resolve(import.meta.dirname, "..");
const helper = path.join(repo, "apps", "desktop", "build", "updater", "ChiefUpdater.exe");
if (!existsSync(helper)) fail("Build the update helper first: npm --prefix apps/desktop run build:updater");
const version = (file) => /(\d+\.\d+\.\d+)/.exec(path.basename(file))?.[1] || fail(`no version in ${file}`);
const [vFrom, vTo] = [version(from), version(to)];

const work = path.join(opt("work") || path.join(path.parse(repo).root, "ChiefBuild", "sandbox-update"), `${vFrom}-to-${vTo}`);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
copyFileSync(from, path.join(work, "from.msix"));
copyFileSync(to, path.join(work, "to.msix"));
copyFileSync(cer, path.join(work, "signing.cer"));
copyFileSync(helper, path.join(work, "ChiefUpdater.exe"));
if (existsSync(`${helper}.config`)) copyFileSync(`${helper}.config`, path.join(work, "ChiefUpdater.exe.config"));

// Inside the sandbox the folder is mapped to C:\test (read-write). The sandbox user is an administrator.
const run = String.raw`
$ErrorActionPreference = 'Continue'
$t = 'C:\test'
$out = "$t\results.txt"
function Say($s) { Add-Content -Path $out -Value ("$(Get-Date -Format s) " + $s) }
Set-Content -Path $out -Value "Sandbox update test ${vFrom} -> ${vTo}"
Import-Certificate -FilePath "$t\signing.cer" -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
Add-AppxPackage -Path "$t\from.msix"
$p = Get-AppxPackage -Name ChiefCommandCenter
Say "installed before: $($p.Version)"
$updater = "$env:LOCALAPPDATA\ChiefCommandCenter\app\updater"
New-Item -ItemType Directory -Force $updater | Out-Null
Copy-Item "$t\ChiefUpdater.exe*" $updater
Start-Process ('shell:AppsFolder\' + $p.PackageFamilyName + '!ChiefCommandCenter')
Start-Sleep -Seconds 20
$app = Get-Process | Where-Object { $_.Path -like "$($p.InstallLocation)*" } | Select-Object -First 1
Say "app running: $([bool]$app) (pid $($app.Id))"
$log = "$t\update-install.log"
$stage = @{ version = 1; packageFile = "$t\to.msix"; packageName = 'ChiefCommandCenter'; from = '${vFrom}'; to = '${vTo}'; logFile = $log } | ConvertTo-Json
Set-Content -Path "$updater\stage.json" -Value $stage
$s = Start-Process "$updater\ChiefUpdater.exe" -ArgumentList 'stage','--job',"$updater\stage.json" -Wait -PassThru -RedirectStandardOutput "$t\stage.out"
Say "stage exit $($s.ExitCode): $((Get-Content "$t\stage.out" -Tail 1))"
$job = @{ version = 1; mode = 'update'; from = '${vFrom}'; to = '${vTo}'; packageFile = "$t\to.msix"; packageName = 'ChiefCommandCenter'; appId = 'ChiefCommandCenter';
  appPid = [int]$app.Id; window = $null; accent = '#E5484D'; facePng = $null; assistantName = 'Chief'; logFile = $log;
  resultFile = "$updater\update-result.json"; shownFile = "$updater\shown-${vTo}"; readyDir = $updater; reducedMotion = $false } | ConvertTo-Json
Set-Content -Path "$updater\job.json" -Value $job
$a = Start-Process "$updater\ChiefUpdater.exe" -ArgumentList 'apply','--job',"$updater\job.json" -PassThru
# The app quits itself once the helper's window shows; here the test closes it the same way.
for ($i = 0; $i -lt 100 -and -not (Test-Path "$updater\shown-${vTo}"); $i++) { Start-Sleep -Milliseconds 100 }
Say "window shown: $(Test-Path "$updater\shown-${vTo}")"
Stop-Process -Id $app.Id -ErrorAction SilentlyContinue
$a.WaitForExit(360000) | Out-Null
Say "apply exit $($a.ExitCode)"
Say "installed after: $((Get-AppxPackage -Name ChiefCommandCenter).Version)"
Say "ready marker: $(Test-Path "$updater\ready-${vTo}")"
if (Test-Path "$updater\update-result.json") { Say ("result: " + (Get-Content "$updater\update-result.json" -Raw)) }
Say "--- helper log ---"
if (Test-Path $log) { Get-Content $log | Add-Content -Path $out }
Say "done"
`;
writeFileSync(path.join(work, "run.ps1"), run.replace(/\n/g, "\r\n"));
const wsb = `<Configuration>
  <MappedFolders><MappedFolder><HostFolder>${work}</HostFolder><SandboxFolder>C:\\test</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders>
  <LogonCommand><Command>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\\test\\run.ps1</Command></LogonCommand>
  <MemoryInMB>8192</MemoryInMB>
</Configuration>
`;
const wsbFile = path.join(work, "update-test.wsb");
writeFileSync(wsbFile, wsb);
console.log(`Opening Windows Sandbox on ${work}. Watch the update window; results.txt there says how it went (a few minutes).`);
spawnSync("cmd.exe", ["/c", "start", "", wsbFile], { stdio: "inherit" });
