// Sign only this app's own executable and the package itself (PLAN §8a: "only our own binaries are signed;
// third-party ones ship unsigned" or with their publishers' signatures). An allow-list, so every file of
// the Hermes payload (Python, Git, Node, ffmpeg…) stays exactly as its publisher shipped it.
const { execFileSync } = require("node:child_process");
const { readdirSync, existsSync } = require("node:fs");
const path = require("node:path");

const OWN = /^(Chief Command Center\.exe|.+\.(appx|msix))$/i;

function signtool() {
  if (process.env.SIGNTOOL_PATH) return process.env.SIGNTOOL_PATH;
  const cache = path.join(process.env.LOCALAPPDATA || "", "electron-builder", "Cache");
  const roots = existsSync(cache) ? readdirSync(cache).filter((d) => d.startsWith("winCodeSign")) : [];
  for (const root of roots) {
    const stack = [path.join(cache, root)];
    while (stack.length) {
      const dir = stack.pop();
      const direct = path.join(dir, "windows-10", "x64", "signtool.exe");
      if (existsSync(direct)) return direct;
      for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory() && entry.name.startsWith("winCodeSign")) stack.push(path.join(dir, entry.name));
    }
  }
  throw new Error("signtool.exe not found; set SIGNTOOL_PATH.");
}

module.exports = async function sign(configuration) {
  if (!OWN.test(path.basename(configuration.path))) return;
  execFileSync(signtool(), configuration.computeSignToolArgs(true), { stdio: "inherit", windowsHide: true });
};
