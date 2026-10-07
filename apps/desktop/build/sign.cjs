// Sign only this app's own executable and the package itself (PLAN §8a: "only our own binaries are signed;
// third-party ones ship unsigned" or with their publishers' signatures). An allow-list, so every file of
// the Hermes payload (Python, Git, Node, ffmpeg…) stays exactly as its publisher shipped it.
//
// SIGNTOOL_PATH should point at a current signtool (Microsoft.Windows.SDK.BuildTools): the 2017 one that
// electron-builder bundles can't sign an MSIX on Windows 11. Errors never repeat the command line, because
// it holds the certificate password.
const { spawnSync } = require("node:child_process");
const { readdirSync, existsSync } = require("node:fs");
const path = require("node:path");

const OWN = /^(Chief Command Center\.exe|ChiefUpdater\.exe|.+\.(appx|msix))$/i;

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
  const file = path.basename(configuration.path);
  if (!OWN.test(file)) return;
  // One SHA-256 signature, timestamped. electron-builder's extra SHA-1 pass is for Windows 7-era loaders.
  if (configuration.hash && configuration.hash !== "sha256") return;
  const info = configuration.cscInfo || {};
  if (!info.file) throw new Error("No signing certificate file (CHIEF_SIGN_PFX).");
  const args = ["sign", "/fd", "sha256", "/tr", "http://timestamp.digicert.com", "/td", "sha256", "/f", info.file];
  if (info.password) args.push("/p", info.password);
  args.push(configuration.path);
  const res = spawnSync(signtool(), args, { encoding: "utf8", windowsHide: true });
  const output = `${res.stdout || ""}${res.stderr || ""}`.split(/\r?\n/).filter((l) => !/\/p\s/i.test(l)).join("\n");
  if (res.status !== 0) throw new Error(`Signing ${file} failed:\n${output.trim().slice(-2000)}`);
  console.log(`  signed ${file}`);
};
