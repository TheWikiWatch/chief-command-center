import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { preparePythonEnv } from "../src/python-env";

/** A payload as the release PC builds it: its venv's pyvenv.cfg names a folder no tester has. */
function fakePayload(root: string) {
  mkdirSync(path.join(root, "venv", "Scripts"), { recursive: true });
  mkdirSync(path.join(root, "venv", "Lib", "site-packages"), { recursive: true });
  mkdirSync(path.join(root, "tools", "python"), { recursive: true });
  writeFileSync(path.join(root, "venv", "pyvenv.cfg"), "home = X:\\Build\\payload\\tools\\python\r\nimplementation = CPython\r\nversion_info = 3.14.7\r\ninclude-system-site-packages = false\r\n");
  for (const name of ["python.exe", "pythonw.exe", "distro.exe", "activate", "activate.bat", "deactivate.bat", "activate.ps1"]) writeFileSync(path.join(root, "venv", "Scripts", name), name);
  const base = path.join(root, "tools", "python", "python.exe");
  writeFileSync(base, "base");
  return base;
}

describe("the agent's Python twin", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "chief-pyenv-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const payload = path.join(dir, "Program Files", "WindowsApps", "Chief_1.0.0", "payload");
  const base = fakePayload(payload);
  const target = path.join(dir, "data", "python-env");

  it("names the installed Python, never the release PC's folder, and adds the payload's packages", () => {
    const scripts = preparePythonEnv(payload, base, target);
    expect(scripts).toBe(path.join(target, "Scripts"));
    const cfg = readFileSync(path.join(target, "pyvenv.cfg"), "utf8");
    expect(cfg.split("\n")[0]).toBe(`home = ${path.dirname(base)}`);
    expect(cfg).not.toContain("X:\\Build");
    expect(cfg).toContain("version_info = 3.14.7");
    const pth = readFileSync(path.join(target, "Lib", "site-packages", "chief-payload.pth"), "utf8");
    expect(pth).toBe(`import site; site.addsitedir(${JSON.stringify(path.join(payload, "venv", "Lib", "site-packages"))})\n`);
  });

  it("copies the launchers but not the activation scripts", () => {
    for (const name of ["python.exe", "pythonw.exe", "distro.exe"]) expect(existsSync(path.join(target, "Scripts", name))).toBe(true);
    for (const name of ["activate", "activate.bat", "deactivate.bat", "activate.ps1"]) expect(existsSync(path.join(target, "Scripts", name))).toBe(false);
  });

  it("is reused while the payload stays put, and rebuilt when an update moves it", () => {
    const before = statSync(path.join(target, "pyvenv.cfg")).mtimeMs;
    expect(preparePythonEnv(payload, base, target)).toBe(path.join(target, "Scripts"));
    expect(statSync(path.join(target, "pyvenv.cfg")).mtimeMs).toBe(before);
    const moved = path.join(dir, "Program Files", "WindowsApps", "Chief_1.0.1", "payload");
    const movedBase = fakePayload(moved);
    preparePythonEnv(moved, movedBase, target);
    expect(readFileSync(path.join(target, "pyvenv.cfg"), "utf8").split("\n")[0]).toBe(`home = ${path.dirname(movedBase)}`);
    expect(existsSync(`${target}.building`)).toBe(false);
  });

  it("gives nothing for a payload without a venv (the app then keeps the payload's own folder)", () => {
    expect(preparePythonEnv(path.join(dir, "nowhere"), base, path.join(dir, "other"))).toBe("");
  });
});
