import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { installedPlugin, launchGateway, leftoverGateway, pluginDigest, processesWhere, processInfo, requestScopedStop, stillTheGateway, type ProcessRecord } from "../src/gateway";
import { systemCwd, systemTool } from "../src/guards";
import { resolvePaths } from "../src/paths";
import { leftoverDashboards, userDataOf } from "../src/web";

/* Security review, low items: Windows tools by absolute path; an orphan is ended only while it's still the gateway. */

const root = mkdtempSync(path.join(tmpdir(), "chief-orphan-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const python = process.env.CHIEF_TEST_PYTHON || "python";
const env = { ...process.env } as Record<string, string>;

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

  it("reads a process's program and start time, with nothing but its answer piped", async () => {
    const me = await processInfo(process.pid);
    expect(path.basename(me?.path || "").toLowerCase()).toBe(path.basename(process.execPath).toLowerCase());
    expect(me!.startedMs).toBeLessThanOrEqual(Date.now());
  }, 30_000);
});

/* S3: the per-user site-packages (a planted .pth or usercustomize.py) never loads into the app's Python. */

describe("the gateway's Python", () => {
  const home = path.join(root, "s3");
  mkdirSync(path.join(home, "profiles", "chief"), { recursive: true });

  it("runs the launcher's own program with -s, the launcher as its argv[0], exactly as the stub would", async () => {
    // A launcher like the payload's: a stub (here a few bytes) with the program zipped behind it, as __main__.py.
    const bin = path.join(home, "payload", "bin");
    mkdirSync(bin, { recursive: true });
    const program = "import json, os, site, sys\nwith open(os.environ['CHIEF_TEST_REPORT'], 'w') as f:\n    json.dump({'argv': sys.argv, 'flag': sys.flags.no_user_site, 'enabled': site.ENABLE_USER_SITE}, f)\n";
    const zip = path.join(home, "program.zip");
    execFileSync(python, ["-c", "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as z: z.writestr('__main__.py', sys.argv[2])", zip, program]);
    const launcher = path.join(bin, "hermes.exe");
    writeFileSync(launcher, Buffer.concat([Buffer.from("MZ a launcher stub\r\n"), readFileSync(zip)]));
    const report = path.join(home, "report.json");
    // The log is a folder, so it can't be written: the gateway must run regardless (and the test keeps no file open).
    const logFile = path.join(home, "unwritable.log");
    mkdirSync(logFile, { recursive: true });
    const exited = new Promise<number | null>((resolve) =>
      launchGateway({ launcher, python, pythonPath: [], hermesRoot: home, profile: "chief", env: { ...env, CHIEF_TEST_REPORT: report }, logFile }, (code) => resolve(code)),
    );
    expect(await exited).toBe(0);
    const seen = JSON.parse(readFileSync(report, "utf8")) as { argv: string[]; flag: number; enabled: boolean };
    expect(seen).toEqual({ argv: [launcher, "-p", "chief", "gateway", "run"], flag: 1, enabled: false });
  }, 30_000);

  it("asks for the planned stop with -s too", async () => {
    // Hermes's marker writer, as the scoped stop imports it: here it says whether the user site was left out.
    const modules = path.join(home, "modules");
    mkdirSync(path.join(modules, "gateway"), { recursive: true });
    writeFileSync(path.join(modules, "gateway", "__init__.py"), "");
    writeFileSync(path.join(modules, "gateway", "status.py"), "import sys\ndef write_planned_stop_marker(pid):\n    return pid == 4242 and sys.flags.no_user_site == 1\n");
    const cfg = { python, pythonPath: [modules], hermesRoot: home, profile: "chief", env };
    expect(await requestScopedStop(cfg, 4242)).toBe(true);
    expect(await requestScopedStop(cfg, 4243)).toBe(false);
  }, 30_000);
});

/* S4: the bridge plugin the gateway loads is the profile's copy, which the agent's tools can reach. */

describe("the profile's copy of the bridge plugin", () => {
  const shipped = path.join(root, "s4", "resources", "plugins", "chief-dashboard-bridge");
  const hermes = path.join(root, "s4", "hermes");
  const copy = installedPlugin(hermes);
  const files: Record<string, string> = { "plugin.yaml": "name: chief-dashboard-bridge\n", "__init__.py": "from . import server\n", "server.py": "PORT = 7790\n", "skills/second-brain/SKILL.md": "# Second Brain\n" };
  for (const dir of [shipped, copy]) {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    }
  }
  // What provisioning never copies: bytecode, and a plain-text token an older install left.
  mkdirSync(path.join(copy, "__pycache__"), { recursive: true });
  writeFileSync(path.join(copy, "__pycache__", "server.cpython-314.pyc"), "bytecode");
  writeFileSync(path.join(copy, ".token"), "synthetic-not-a-credential");

  it("is in the profile, and compares equal to the packaged plugin until either changes", async () => {
    expect(copy).toBe(path.join(hermes, "profiles", "chief", "plugins", "chief-dashboard-bridge"));
    expect(await pluginDigest(copy)).toBe(await pluginDigest(shipped));
  });

  it("an edited, added or removed file is a difference, and so is a missing copy", async () => {
    const before = await pluginDigest(copy);
    writeFileSync(path.join(copy, "server.py"), "PORT = 7790\nimport os; os.system('calc')\n");
    expect(await pluginDigest(copy)).not.toBe(before);
    writeFileSync(path.join(copy, "server.py"), files["server.py"]);
    expect(await pluginDigest(copy)).toBe(before);
    writeFileSync(path.join(copy, "extra.py"), "");
    expect(await pluginDigest(copy)).not.toBe(before);
    rmSync(path.join(copy, "extra.py"));
    rmSync(path.join(copy, "skills", "second-brain", "SKILL.md"));
    expect(await pluginDigest(copy)).not.toBe(before);
    writeFileSync(path.join(copy, "skills", "second-brain", "SKILL.md"), files["skills/second-brain/SKILL.md"]);
    expect(await pluginDigest(path.join(hermes, "nowhere"))).not.toBe(before);
  });

  it("doesn't follow a link into somewhere else", async () => {
    const elsewhere = path.join(root, "s4", "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    const link = path.join(copy, "skills", "linked");
    try {
      symlinkSync(elsewhere, link, "junction");
    } catch {
      return; // no links on this file system
    }
    expect(await pluginDigest(copy)).not.toBe(await pluginDigest(shipped));
    rmSync(link, { recursive: false, force: true });
  });
});

/* Leftovers: what an earlier run of this app left running on its data folder after a forced quit. */

describe("leftover processes", () => {
  const launcher = "C:\\App\\resources\\payload\\bin\\hermes.exe";
  const written = Date.parse("2026-11-10T10:00:00Z");
  const proc = (over: Partial<ProcessRecord>): ProcessRecord => ({ pid: 4242, parent: 1, path: "C:\\App\\resources\\payload\\tools\\python-3.14\\python.exe", command: `"C:\\App\\resources\\payload\\tools\\python-3.14\\python.exe" -s "${launcher}" -p chief gateway run`, startedMs: written - 5000, ...over });

  it("a gateway is ours only when the pid file names it, it runs this payload's launcher as gateway run, and it started before the file", () => {
    expect(leftoverGateway(proc({}), launcher, written, false)).toBe(true);
    // The old way: the launcher's stub itself, and the Python it started.
    expect(leftoverGateway(proc({ path: launcher, command: `"${launcher}" -p chief gateway run` }), launcher, written, false)).toBe(true);
    expect(leftoverGateway(proc({ command: `"python.exe" "D:\\Other\\payload\\bin\\hermes.exe" -p chief gateway run` }), launcher, written, false)).toBe(false);
    expect(leftoverGateway(proc({ command: `"python.exe" -s "${launcher}" -p chief gateway status` }), launcher, written, false)).toBe(false);
    expect(leftoverGateway(proc({ startedMs: written + 3_600_000 }), launcher, written, false)).toBe(false); // Windows gave the pid to something newer
    expect(leftoverGateway(proc({ path: "C:\\Tools\\editor.exe" }), launcher, written, false)).toBe(false);
    expect(leftoverGateway(undefined, launcher, written, false)).toBe(false);
    expect(leftoverGateway(proc({}), launcher, 0, false)).toBe(false); // no pid file
  });

  it("from source, never a process of the installed app", () => {
    const installed = "C:\\Program Files\\WindowsApps\\ChiefCommandCenter_1.0.0.0_x64__abc\\app\\resources\\payload\\bin\\hermes.exe";
    const theirs = proc({ path: installed, command: `"${installed}" -p chief gateway run` });
    expect(leftoverGateway(theirs, installed, written, true)).toBe(false);
    expect(leftoverGateway(theirs, installed, written, false)).toBe(true); // the installed app's own leftover
  });

  it("a dashboard server is ours only from this executable and Electron profile, and not this run's own", () => {
    const exe = "C:\\Program Files\\WindowsApps\\ChiefCommandCenter_1.0.0.0_x64__abc\\app\\Chief Command Center.exe";
    const userData = "C:\\Users\\user\\AppData\\Roaming\\@chief\\desktop";
    const node = (over: Partial<ProcessRecord>): ProcessRecord => ({
      pid: 900,
      parent: 800,
      path: exe,
      command: `"${exe}" --type=utility --utility-sub-type=node.mojom.NodeService --lang=en-US --service-sandbox-type=none --user-data-dir="C:\\Users\\user\\AppData\\Roaming\\@chief/desktop" --field-trial-handle=1`,
      startedMs: 0,
      ...over,
    });
    const ours = { exe, userData, pid: 700 };
    expect(leftoverDashboards([node({})], ours)).toEqual([900]);
    expect(leftoverDashboards([node({ parent: 700 })], ours)).toEqual([]); // this run's own server
    expect(leftoverDashboards([node({ command: node({}).command.replace("node.mojom.NodeService", "network.mojom.NetworkService") })], ours)).toEqual([]);
    expect(leftoverDashboards([node({ command: node({}).command.replace("@chief/desktop", "chief-dev") })], ours)).toEqual([]); // another profile
    // Running from source: Electron's own executable, never the installed app's.
    expect(leftoverDashboards([node({})], { ...ours, exe: "E:\\repo\\apps\\desktop\\node_modules\\electron\\dist\\electron.exe" })).toEqual([]);
    // The query's own PowerShell names the filter text too.
    expect(leftoverDashboards([node({ path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" })], ours)).toEqual([]);
    expect(userDataOf("x --user-data-dir=E:\\Work\\electron --y")).toBe("e:\\work\\electron");
    expect(userDataOf("x --type=renderer")).toBe("");
  });

  it("asks Windows for processes by a filter, with their command lines", async () => {
    const [me] = await processesWhere(`ProcessId = ${process.pid}`);
    expect(me).toMatchObject({ pid: process.pid, parent: process.ppid });
    expect(path.basename(me.path).toLowerCase()).toBe(path.basename(process.execPath).toLowerCase());
    expect(me.command.length).toBeGreaterThan(0);
    expect(me.startedMs).toBeLessThanOrEqual(Date.now());
    expect(await processesWhere("ProcessId = 0 AND ProcessId = 1")).toEqual([]);
  }, 30_000);
});

/* S6: the installed app ignores the developer overrides in the user's environment. */

describe("developer overrides", () => {
  const overrides = { LOCALAPPDATA: "D:\\Home\\AppData\\Local", CHIEF_DESKTOP_DATA: "D:\\Elsewhere", CHIEF_PAYLOAD_DIR: "D:\\Payload", CHIEF_GOOGLE_CLIENT_FILE: "D:\\client.json" };
  const at = { resourcesPath: "C:\\App\\resources", appPath: "C:\\App\\resources\\app.asar", env: overrides };

  it("are ignored when packaged", () => {
    const p = resolvePaths({ packaged: true, ...at });
    expect(p.data).toBe(path.join("D:\\Home\\AppData\\Local", "ChiefCommandCenter"));
    expect(p.payload).toBe(path.join("C:\\App\\resources", "payload"));
    expect(p.googleClient).toBe(path.join("C:\\App\\resources", "google-client.json"));
  });

  it("still work from source (throwaway runs, the smoke test)", () => {
    const p = resolvePaths({ packaged: false, ...at });
    expect(p.data).toBe(path.resolve("D:\\Elsewhere"));
    expect(p.payload).toBe(path.resolve("D:\\Payload"));
    expect(p.googleClient).toBe(path.resolve("D:\\client.json"));
  });
});
