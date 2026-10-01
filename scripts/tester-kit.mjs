#!/usr/bin/env node
// The setup zip to send a new tester (docs/DISTRIBUTION.md, "Sharing with a new tester").
//
//   node scripts/tester-kit.mjs                  the newest package in releasesDir
//   node scripts/tester-kit.mjs --version X.Y.Z  a particular one
//
// The zip holds "Install Chief.cmd" and install-chief.ps1 (packaging/tester/), a README, the publisher certificate
// (the public .cer, never the .pfx) and the signed package. It never holds an update key: send each person's key
// separately. Reads testerCert and releasesDir from release.local.json; writes
// <releasesDir>\Chief-Command-Center-setup-<version>.zip.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

const localFile = path.join(repo, "release.local.json");
if (!existsSync(localFile)) fail(`Missing ${localFile}. Copy release.local.example.json and fill in this PC's paths.`);
const local = JSON.parse(readFileSync(localFile, "utf8"));
for (const k of ["releasesDir", "testerCert"]) if (!local[k]) fail(`release.local.json lacks ${k}.`);
if (!existsSync(local.testerCert)) fail(`testerCert not found: ${local.testerCert}`);
if (path.extname(local.testerCert).toLowerCase() !== ".cer") fail("testerCert must be the public .cer, never the .pfx.");

const byVersion = (a, b) => a.split(".").map(Number).reduce((d, n, i) => d || n - Number(b.split(".")[i]), 0);
const built = readdirSync(local.releasesDir)
  .map((f) => /^Chief Command Center (\d+\.\d+\.\d+)\.appx$/.exec(f)?.[1])
  .filter(Boolean)
  .sort(byVersion);
const version = opt("version") || built.at(-1);
if (!version) fail(`No "Chief Command Center X.Y.Z.appx" in ${local.releasesDir}. Build a release first.`);
const pkg = path.join(local.releasesDir, `Chief Command Center ${version}.appx`);
if (!existsSync(pkg)) fail(`Not found: ${pkg}`);

const name = `Chief Command Center setup ${version}`;
const stage = path.join(local.releasesDir, `.kit-${version}`);
const folder = path.join(stage, name);
rmSync(stage, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
for (const f of ["Install Chief.cmd", "install-chief.ps1", "README.txt"]) copyFileSync(path.join(repo, "packaging", "tester", f), path.join(folder, f));
copyFileSync(local.testerCert, path.join(folder, path.basename(local.testerCert)));
copyFileSync(pkg, path.join(folder, `ChiefCommandCenter-${version}.appx`));

const zip = path.join(local.releasesDir, `Chief-Command-Center-setup-${version}.zip`);
rmSync(zip, { force: true });
console.log(`Zipping ${name} (about a minute)…`);
// Windows' own tar writes zip files with -a.
const r = spawnSync("tar.exe", ["-a", "-c", "-f", zip, "-C", stage, name], { stdio: "inherit" });
rmSync(stage, { recursive: true, force: true });
if (r.status !== 0) fail(`tar failed (exit ${r.status}).`);
console.log(`\n✓ ${zip} (${Math.round(statSync(zip).size / 1048576)} MB)`);
console.log("Send it (a OneDrive or Google Drive link works), and each person's update key separately.");
