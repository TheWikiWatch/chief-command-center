// The desktop app, end to end, on a throwaway data folder: boot, the dashboard, a chat round trip with the scripted
// fake model, an approval, and a clean quit, driven by Playwright's Electron support.
//
//   node scripts/smoke-electron.mjs [--payload <dir>] [--work <dir>] [--keep]
//
// Needs the desktop shell built (npm --prefix apps/desktop run build), the dashboard's standalone build
// (npm --prefix apps/web run build:standalone) and a Hermes payload (--payload, else CHIEF_PAYLOAD_DIR, else
// release.local.json's payloadDir). Everything runs on new ports in the work folder. The owner's installed Chief
// is never touched: the script checks that its gateway is the same process, still running, before and after.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(repo, "apps", "desktop");
const require = createRequire(path.join(desktop, "package.json"));
const { _electron } = require("playwright-core");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : "");

function localPayload() {
  try {
    return JSON.parse(readFileSync(path.join(repo, "release.local.json"), "utf8")).payloadDir || "";
  } catch {
    return "";
  }
}

const payload = option("--payload") || process.env.CHIEF_PAYLOAD_DIR || localPayload();
const work = option("--work") || mkdtempSync(path.join(tmpdir(), "chief-smoke-"));
const data = path.join(work, "data");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail && !ok ? ` (${detail})` : ""}`);
  return ok;
};

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** The installed Chief's gateway, if one runs: its pid from the live profile, and whether it's alive. */
function liveGateway() {
  const file = path.join(process.env.LOCALAPPDATA || "", "hermes", "profiles", "chief", "gateway.pid");
  try {
    const text = readFileSync(file, "utf8").trim();
    const pid = Number(text.startsWith("{") ? JSON.parse(text).pid : text) || 0;
    if (!pid) return null;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      alive = e.code === "EPERM";
    }
    return { pid, alive };
  } catch {
    return null;
  }
}

function payloadPython() {
  const manifest = JSON.parse(readFileSync(path.join(payload, "manifest.json"), "utf8")).runtime;
  return {
    python: path.join(payload, manifest.storePython),
    pythonPath: [path.join(payload, manifest.sitePackages), path.join(payload, manifest.repoDir)].join(";"),
  };
}

async function main() {
  if (!payload || !existsSync(path.join(payload, "manifest.json"))) throw new Error("No Hermes payload: pass --payload <dir> or set CHIEF_PAYLOAD_DIR.");
  if (!existsSync(path.join(desktop, "dist", "main.js"))) throw new Error("Build the desktop shell first (npm --prefix apps/desktop run build).");
  if (!existsSync(path.join(repo, "apps", "web", ".next", "standalone", "server.js"))) throw new Error("Build the dashboard first (npm --prefix apps/web run build:standalone).");
  mkdirSync(data, { recursive: true });
  const before = liveGateway();

  // The scripted model, and the profile pointed at it (what onboarding does by hand).
  const modelPort = await freePort();
  const fake = spawn("python", [path.join(repo, "hermes", "tests", "fixtures", "fake_model.py"), String(modelPort)], { stdio: "ignore", windowsHide: true });
  const profile = path.join(data, "hermes", "profiles", "chief");
  mkdirSync(profile, { recursive: true });
  const { python, pythonPath } = payloadPython();
  const env = { ...process.env, HERMES_HOME: profile, PYTHONPATH: pythonPath, PYTHONIOENCODING: "utf-8" };
  const provision = spawnSync(python, ["-B", path.join(desktop, "python", "provision.py"), "--plugins-src", path.join(repo, "hermes", "plugins"), "--bridge-port", String(await freePort())], { env, encoding: "utf8" });
  check("throwaway profile prepared", provision.status === 0, provision.stdout?.slice(-300));
  const connect = [
    "import sys, types, importlib.util, pathlib",
    "plugin = pathlib.Path(sys.argv[1])",
    "pkg = types.ModuleType('bridge'); pkg.__path__ = [str(plugin)]; sys.modules['bridge'] = pkg",
    "def load(n):",
    "    spec = importlib.util.spec_from_file_location('bridge.' + n, plugin / (n + '.py')); m = importlib.util.module_from_spec(spec); sys.modules['bridge.' + n] = m; spec.loader.exec_module(m); return m",
    "load('util'); load('data'); providers = load('providers')",
    "r = providers.save_endpoint('Local model', sys.argv[2], 'tiny-local', '')",
    "print(r); sys.exit(0 if r.get('ok') else 1)",
  ].join("\n");
  const connected = spawnSync(python, ["-B", "-c", connect, path.join(repo, "hermes", "plugins", "chief-dashboard-bridge"), `http://127.0.0.1:${modelPort}/v1`], { env, encoding: "utf8" });
  check("fake model connected", connected.status === 0, (connected.stdout || connected.stderr || "").slice(-300));

  const electronPath = require("electron");
  const started = Date.now();
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [desktop, `--user-data-dir=${path.join(data, "electron")}`],
    env: { ...process.env, CHIEF_DESKTOP_DATA: data, CHIEF_PAYLOAD_DIR: payload },
    timeout: 60_000,
  });
  let ok = true;
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 180_000 });
    await page.waitForLoadState("domcontentloaded");
    ok = check("the dashboard opens", true) && ok;
    console.log(`     after ${((Date.now() - started) / 1000).toFixed(1)} s`);

    const box = page.locator("textarea").first();
    await box.waitFor({ state: "visible", timeout: 60_000 });
    await box.fill("hello smoke test");
    await box.press("Enter");
    await page.getByText("Hello from the local test model", { exact: false }).last().waitFor({ timeout: 90_000 });
    ok = check("a chat round trip", true) && ok;

    await box.fill("APPROVEME please");
    await box.press("Enter");
    const allow = page.getByRole("button", { name: "Allow once" });
    await allow.waitFor({ timeout: 90_000 });
    ok = check("an approval is asked for", true) && ok;
    await allow.click();
    await page.getByText("Approved and ran.", { exact: false }).last().waitFor({ timeout: 90_000 });
    ok = check("an approved command runs and the chief answers", true) && ok;
  } catch (error) {
    ok = check("the smoke run", false, error instanceof Error ? error.message.split("\n")[0] : String(error));
  } finally {
    // The app's own Quit path: Chief stops and the app exits.
    const closed = new Promise((resolve) => app.process().once("exit", (code) => resolve(code)));
    // The chief's words show before its turn has ended, so Quit can find it still busy and ask "Wait for Chief /
    // Quit now", a native dialog nobody is here to click (the 0.1.24 run timed out on it). Answer "Wait for Chief"
    // as a person would: the app's own wait-then-stop path runs, whatever the timing.
    await app.evaluate(({ app: electronApp, dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
      electronApp.quit();
    }).catch(() => undefined);
    const code = await Promise.race([closed, new Promise((r) => setTimeout(() => r("timeout"), 90_000))]);
    ok = check("the app quits cleanly", code === 0, `exit ${code}`) && ok;
    // The whole tree: killing only the main process left the throwaway gateway running and its folder locked.
    if (code === "timeout") {
      const pid = app.process().pid;
      if (process.platform === "win32" && pid) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      else app.process().kill();
    }
    fake.kill();
  }

  const after = liveGateway();
  if (before) ok = check("the installed Chief's gateway is untouched", !!after && after.pid === before.pid && after.alive === before.alive, JSON.stringify({ before, after })) && ok;
  else console.log("     (no installed Chief gateway running here)");
  return ok;
}

let passed = false;
try {
  passed = await main();
} catch (error) {
  check("the smoke run", false, error instanceof Error ? error.message : String(error));
} finally {
  if (!flag("--keep") && !option("--work")) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
console.log(passed && results.every((r) => r.ok) ? "\nsmoke passed" : `\nsmoke FAILED (${results.filter((r) => !r.ok).length})`);
process.exit(passed && results.every((r) => r.ok) ? 0 : 1);
