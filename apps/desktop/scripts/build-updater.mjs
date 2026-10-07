// Builds Chief Updater (updater-helper/, C# on .NET Framework 4.8) and puts ChiefUpdater.exe where the package picks it
// up: build/updater/ (electron-builder.config.cjs extraResources). Needs the .NET SDK (`dotnet`); net48 itself ships
// with Windows, and the reference assemblies come from NuGet.
//
// With CHIEF_SIGN_PFX set, the exe is Authenticode-signed the way build/sign.cjs signs the app (SIGNTOOL_PATH,
// CHIEF_SIGN_PASSWORD). The command line holds the password, so it is never printed, and "/p" lines are dropped
// from signtool's output.
//
//   node apps/desktop/scripts/build-updater.mjs        (npm --prefix apps/desktop run build:updater)
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(desktop, "updater-helper", "ChiefUpdater.csproj");
const built = path.join(desktop, "updater-helper", "bin", "Release", "net48");
const out = path.join(desktop, "build", "updater");
const files = ["ChiefUpdater.exe", "ChiefUpdater.exe.config"];

function fail(message) {
  console.error(`build-updater: ${message}`);
  process.exit(1);
}

if (process.platform !== "win32") fail("Chief Updater builds on Windows only.");

const build = spawnSync("dotnet", ["build", project, "-c", "Release", "-nologo", "-v", "quiet", "-clp:NoSummary;ErrorsOnly;WarningsOnly"], {
  encoding: "utf8",
  windowsHide: true,
});
if (build.error) fail(`couldn't run dotnet (${build.error.message}); install the .NET SDK.`);
const report = `${build.stdout || ""}${build.stderr || ""}`.trim();
if (build.status !== 0) fail(`dotnet build failed:\n${report.slice(-4000)}`);
if (report) console.log(report);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const file of files) {
  const from = path.join(built, file);
  if (!existsSync(from)) fail(`${file} wasn't built (looked in ${built}).`);
  copyFileSync(from, path.join(out, file));
}
const exe = path.join(out, "ChiefUpdater.exe");

if (process.env.CHIEF_SIGN_PFX) {
  const signtool = process.env.SIGNTOOL_PATH;
  if (!signtool) fail("CHIEF_SIGN_PFX is set but SIGNTOOL_PATH isn't.");
  const args = ["sign", "/fd", "sha256", "/tr", "http://timestamp.digicert.com", "/td", "sha256", "/f", process.env.CHIEF_SIGN_PFX];
  if (process.env.CHIEF_SIGN_PASSWORD) args.push("/p", process.env.CHIEF_SIGN_PASSWORD);
  args.push(exe);
  const res = spawnSync(signtool, args, { encoding: "utf8", windowsHide: true });
  const output = `${res.stdout || ""}${res.stderr || ""}`.split(/\r?\n/).filter((l) => !/\/p\s/i.test(l)).join("\n");
  if (res.status !== 0) fail(`signing ChiefUpdater.exe failed:\n${output.trim().slice(-2000)}`);
  console.log("  signed ChiefUpdater.exe");
}

// A self-test of the very exe that ships: a simulated stage must speak the protocol the app reads (update-helper.ts).
const probe = mkdtempSync(path.join(tmpdir(), "chief-updater-"));
try {
  const job = path.join(probe, "stage.json");
  writeFileSync(job, JSON.stringify({ version: 1, packageFile: path.join(probe, "ChiefCommandCenter-0.0.1.msix"), packageName: "ChiefCommandCenter", from: "0.0.0", to: "0.0.1", logFile: path.join(probe, "log.txt") }));
  const run = spawnSync(exe, ["stage", "--job", job, "--simulate"], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  const lines = String(run.stdout || "").trim().split(/\r?\n/);
  if (run.status !== 0 || !/"phase":"staged"/.test(lines.at(-1) || "")) fail(`the self-test failed (exit ${run.status}): ${lines.slice(-3).join(" | ")}`);
} finally {
  rmSync(probe, { recursive: true, force: true });
}

console.log(`built ${path.relative(process.cwd(), exe) || exe} (self-test passed)`);
