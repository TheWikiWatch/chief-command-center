import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A working Python for the agent's own commands (`python`, `pip`, and the payload's other command launchers).
 *
 * The payload's venv is built on the release PC, and its `pyvenv.cfg` names that PC's folder as `home`. Windows' venv
 * launcher (`venv\Scripts\python.exe`, which every other launcher in that folder starts) reads that line and fails
 * with exit 103 anywhere else; the payload is read-only once installed, so it can't be rewritten in place. This
 * writes a twin of the venv in the app's data folder: the same launchers, a `pyvenv.cfg` naming the installed
 * Python, and a `.pth` that adds the payload's own site-packages (its `.pth` files included). The app's own
 * processes never needed it: they start the base Python with PYTHONPATH (env.ts).
 *
 * Rebuilt whenever the payload's location or launchers change (every update installs to a new folder). Returns the
 * twin's Scripts folder, or "" when the payload has no venv or the twin couldn't be written.
 */
export function preparePythonEnv(payloadRoot: string, basePython: string, target: string): string {
  const venv = path.join(payloadRoot, "venv");
  const scripts = path.join(venv, "Scripts");
  const cfgFile = path.join(venv, "pyvenv.cfg");
  if (!existsSync(scripts) || !existsSync(cfgFile) || !existsSync(basePython)) return "";
  const launchers = readdirSync(scripts).filter((n) => !/^(activate|deactivate)/i.test(n) && statSync(path.join(scripts, n)).isFile());
  const sitePackages = path.join(venv, "Lib", "site-packages");
  const stamp = JSON.stringify({
    payloadRoot: path.resolve(payloadRoot),
    basePython: path.resolve(basePython),
    launchers: launchers.map((n) => [n, statSync(path.join(scripts, n)).size]),
  });
  const stampFile = path.join(target, "chief-python-env.json");
  const out = path.join(target, "Scripts");
  try {
    if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp && existsSync(path.join(out, "python.exe"))) return out;
  } catch {
    // rebuild below
  }
  // Built beside the target and swapped in, so a half-written twin is never on the agent's PATH.
  const stage = `${target}.building`;
  try {
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(path.join(stage, "Scripts"), { recursive: true });
    mkdirSync(path.join(stage, "Lib", "site-packages"), { recursive: true });
    for (const name of launchers) copyFileSync(path.join(scripts, name), path.join(stage, "Scripts", name));
    const kept = readFileSync(cfgFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() && !/^(home|executable|base-executable|base-prefix|base-exec-prefix|command)\s*=/i.test(line.trim()));
    writeFileSync(path.join(stage, "pyvenv.cfg"), [`home = ${path.dirname(path.resolve(basePython))}`, ...kept, ""].join("\n"));
    // addsitedir (not a plain path line) so the payload's own .pth files run too: hermes-agent, pywin32.
    writeFileSync(path.join(stage, "Lib", "site-packages", "chief-payload.pth"), `import site; site.addsitedir(${JSON.stringify(sitePackages)})\n`);
    writeFileSync(path.join(stage, "chief-python-env.json"), stamp);
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    renameSync(stage, target);
    return out;
  } catch {
    rmSync(stage, { recursive: true, force: true });
    // An agent `python` still running from the old twin keeps its files locked; it is rebuilt at the next start.
    return existsSync(path.join(out, "python.exe")) ? out : "";
  }
}
