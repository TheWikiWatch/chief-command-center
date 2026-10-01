#!/usr/bin/env node
// One command to ship a new version of the app to everyone who has it (docs/DISTRIBUTION.md).
//
//   node scripts/release.mjs --notes "What changed, in a sentence or two"   [--version X.Y.Z]
//   node scripts/release.mjs --plan                                          (check the setup; changes nothing)
//
// Steps: checks that the tree is committed and the dev server is stopped → the full test suite → bumps the
// version (patch by default) → builds the dashboard and the signed package → verifies the signature and that no
// password reached the logs → writes the signed release manifest → commits and pushes the version → publishes the
// release to the private releases repository. Installed apps offer it within a day (or at once with "Check now").
//
// This PC's locations (build folder, signing files, releases repository) are in release.local.json at the repo
// root, which is git-ignored; see release.local.example.json.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}
function step(message) {
  console.log(`\n▶ ${message}`);
}
function run(cmd, cmdArgs, options = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: repo, stdio: options.capture ? "pipe" : "inherit", encoding: "utf8", shell: options.shell ?? false, env: options.env ?? process.env });
  if (r.status !== 0 && !options.allowFail) fail(`${options.what || [cmd, ...cmdArgs].join(" ")} failed (exit ${r.status}).`);
  return r;
}
const portBusy = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });

const devServer = async () => (await portBusy(3100)) || (await portBusy(3102));

// ---------------------------------------------------------------- this PC's setup

const localFile = path.join(repo, "release.local.json");
if (!existsSync(localFile)) fail(`Missing ${localFile}. Copy release.local.example.json and fill in this PC's paths.`);
const local = JSON.parse(readFileSync(localFile, "utf8"));
const need = ["payloadDir", "releaseDir", "releasesDir", "feedDir", "signtool", "pfx", "pfxPasswordFile", "releaseKey", "releasesRepo"];
const missing = need.filter((k) => !local[k]);
if (missing.length) fail(`release.local.json lacks: ${missing.join(", ")}`);
const notFound = ["payloadDir", "signtool", "pfx", "pfxPasswordFile", "releaseKey"].filter((k) => !existsSync(local[k]));

const desktopPkg = path.join(repo, "apps", "desktop", "package.json");
const desktopLock = path.join(repo, "apps", "desktop", "package-lock.json");
const current = JSON.parse(readFileSync(desktopPkg, "utf8")).version;
const bump = (v) => v.split(".").map((n, i) => (i === 2 ? Number(n) + 1 : Number(n))).join(".");
const version = opt("version") || bump(current);
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`--version must look like 1.2.3 (got ${version}).`);

const git = (...a) => run("git", a, { capture: true }).stdout.trim();
const dirty = git("status", "--porcelain");
const branch = git("branch", "--show-current");

// The manifest describes Hermes from hermes/pin.json, but the package carries the payload: they must agree.
function hermesMismatch() {
  const pin = JSON.parse(readFileSync(path.join(repo, "hermes", "pin.json"), "utf8"));
  let stamp = {};
  try {
    stamp = JSON.parse(readFileSync(path.join(local.payloadDir, "hermes-agent", "install-stamp.json"), "utf8"));
  } catch {}
  const short = (c) => String(c || "none").slice(0, 7);
  console.log(`Hermes: hermes/pin.json ${pin.baseVersion} (${short(pin.commit)}), payload ${stamp.baseVersion || "?"} (${short(stamp.upstreamCommit)})`);
  return stamp.upstreamCommit === pin.commit
    ? ""
    : `The payload holds Hermes ${short(stamp.upstreamCommit)} but hermes/pin.json says ${short(pin.commit)}. Rebuild the payload (CLAUDE.md, "Hermes updates") or point payloadDir at the right one.`;
}

if (flag("plan")) {
  console.log(`Current version ${current} → next ${version}`);
  const mismatch = hermesMismatch();
  if (mismatch) console.log(`   ← ${mismatch}`);
  console.log(`Branch: ${branch}${dirty ? " (uncommitted changes: commit them before releasing)" : " (clean)"}`);
  console.log(`Dev server: ${(await devServer()) ? "RUNNING (stop it first: it shares the build folder)" : "stopped"}`);
  for (const k of need) console.log(`  ${k}: ${local[k]}${notFound.includes(k) ? "   ← NOT FOUND" : ""}`);
  const gh = run("gh", ["repo", "view", local.releasesRepo, "--json", "visibility"], { capture: true, allowFail: true });
  console.log(`Releases repository: ${gh.status === 0 ? JSON.parse(gh.stdout).visibility.toLowerCase() + ", reachable with your gh login" : "NOT reachable (gh auth login?)"}`);
  process.exit(notFound.length || mismatch || gh.status !== 0 ? 1 : 0);
}

const notes = opt("notes") || (opt("notes-file") ? readFileSync(opt("notes-file"), "utf8").trim() : "");
if (!notes) fail('Say what changed: --notes "…" (testers see it on the update card).');
if (notFound.length) fail(`Not found: ${notFound.map((k) => `${k} (${local[k]})`).join(", ")}`);
if (branch !== "main") fail(`Release from main (you're on ${branch}).`);
if (dirty) fail("Commit (or discard) your changes first: a release is built from what's committed.");
if (await devServer()) fail("The dashboard dev server (3100 or 3102) is running; stop it first. It shares apps/web/.next with the build.");
const mismatch = hermesMismatch();
if (mismatch) fail(mismatch);
run("git", ["fetch", "-q", "origin"]);
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) fail("main differs from origin/main: pull or push first.");

// ---------------------------------------------------------------- build

step("Running every check (web, desktop, Python, privacy)…");
if (!flag("skip-checks")) run("npm", ["run", "check"], { shell: true, what: "npm run check" });

step(`Version ${current} → ${version}`);
const pkg = JSON.parse(readFileSync(desktopPkg, "utf8"));
pkg.version = version;
writeFileSync(desktopPkg, JSON.stringify(pkg, null, 2) + "\n");
const lock = JSON.parse(readFileSync(desktopLock, "utf8"));
lock.version = version;
if (lock.packages?.[""]) lock.packages[""].version = version;
writeFileSync(desktopLock, JSON.stringify(lock, null, 2) + "\n");

step("Building the dashboard…");
run("npm", ["--prefix", "apps/web", "run", "build:standalone"], { shell: true, what: "the dashboard build" });

step("Building and signing the package (about 5 minutes)…");
const password = readFileSync(local.pfxPasswordFile, "utf8").trim();
rmSync(local.releaseDir, { recursive: true, force: true });
const build = spawnSync("npm", ["run", "dist:msix"], {
  cwd: path.join(repo, "apps", "desktop"),
  shell: true,
  encoding: "utf8",
  env: { ...process.env, SIGNTOOL_PATH: local.signtool, CHIEF_PAYLOAD_DIR: local.payloadDir, CHIEF_RELEASE_DIR: local.releaseDir, CHIEF_SIGN_PFX: local.pfx, CHIEF_SIGN_PASSWORD: password },
});
const buildLog = path.join(local.releasesDir, `build-${version}.log`);
mkdirSync(local.releasesDir, { recursive: true });
writeFileSync(buildLog, `${build.stdout}\n${build.stderr}`);
if (build.status !== 0) fail(`The package build failed; see ${buildLog}.`);
if (readFileSync(buildLog, "utf8").includes(password)) fail(`The signing password appeared in ${buildLog}: delete that log and investigate before releasing.`);

const built = path.join(local.releaseDir, `Chief Command Center ${version}.appx`);
if (!existsSync(built)) fail(`The build finished but ${built} isn't there.`);
step("Verifying the package signature…");
run(local.signtool, ["verify", "/pa", built], { capture: true, what: "signtool verify" });

// GitHub renames files with spaces, so the published package has none.
const archive = path.join(local.releasesDir, `Chief Command Center ${version}.appx`);
copyFileSync(built, archive);
mkdirSync(local.feedDir, { recursive: true });
const feedPkg = path.join(local.feedDir, `ChiefCommandCenter-${version}.msix`);
copyFileSync(built, feedPkg);
const notesFile = path.join(local.feedDir, `notes-${version}.txt`);
writeFileSync(notesFile, notes + "\n");
const out = path.join(local.feedDir, version);
rmSync(out, { recursive: true, force: true });

step("Writing and checking the signed release description…");
run("node", ["packaging/release/release-tool.mjs", "make", "--msix", feedPkg, "--version", version, "--key", local.releaseKey, "--out", out, "--notes", notesFile]);
const pinned = /RELEASE_PUBLIC_KEY = "([^"]+)"/.exec(readFileSync(path.join(repo, "apps", "desktop", "src", "release-key.ts"), "utf8"))[1];
run("node", ["packaging/release/release-tool.mjs", "verify", "--dir", out, "--pub", pinned]);
rmSync(feedPkg, { force: true });

step("Committing the version…");
run("git", ["add", "apps/desktop/package.json", "apps/desktop/package-lock.json"]);
run("git", ["commit", "-q", "-m", `Release ${version}\n\n${notes}`]);
run("git", ["push", "-q", "origin", "main"]);

if (flag("no-publish")) {
  console.log(`\n✓ Built ${version} (not published): ${out}`);
  process.exit(0);
}
step(`Publishing ${version} to ${local.releasesRepo}…`);
run("node", ["packaging/release/release-tool.mjs", "publish", "--dir", out, "--repo", local.releasesRepo]);
console.log(`\n✓ Released ${version}. Installed apps offer it within a day, or at once with Settings → Backup & updates → Check now.`);
