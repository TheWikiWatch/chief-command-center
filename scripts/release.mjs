#!/usr/bin/env node
// One command to ship a new version of the app to everyone who has it (docs/DISTRIBUTION.md).
//
//   node scripts/release.mjs --notes "What changed, in a sentence or two"   [--version X.Y.Z] [--channel early]
//                            [--hermes-highlights "One thing; another"]   ("New in Hermes" after an update that moves Hermes)
//   node scripts/release.mjs --plan                                          (check the setup; changes nothing)
//   node scripts/release.mjs --promote X.Y.Z                                 (an early release, to everyone)
//
// Channels (docs/DISTRIBUTION.md, "Early updates"): `--channel early` publishes the release as a GitHub prerelease.
// Testers' apps read the repository's latest release, which GitHub never points at a prerelease, so only an app with
// Settings → Updates → Early updates on (the owner's) is offered it. After a day or two of use, `--promote` makes the
// same signed release the latest for everyone (nothing is rebuilt) and refreshes the tester kit. The default channel,
// everyone, is what it always was.
//
// Steps: checks that the tree is committed and the dev server is stopped → the full test suite → bumps the
// version (patch by default) → builds the dashboard → a smoke test of the app on a throwaway data folder (boot, a chat
// round trip, an approval, quit; --skip-smoke to leave it out) → builds the signed package → verifies the signature and that no
// password reached the logs → writes the signed release manifest → uploads it as a DRAFT release (invisible to installed
// apps) → commits, tags v<version> and pushes → makes the draft the latest release. Installed apps offer it within a
// day (or at once with "Check now"). Any failure before the push puts the version files back and deletes the draft.
// --no-publish builds everything and leaves the committed version alone; --skip-checks works only with it.
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
/**
 * The environment for every step: PATH without duplicates and without the node_modules\.bin folders npm added for
 * this script. Each nested `npm run` adds a few hundred characters, and cmd.exe stops finding programs once PATH
 * passes 8191 (a long PATH plus the four levels of `npm run check` failed with "'tsc' is not recognized").
 */
const stepEnv = (() => {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === "path") || "PATH";
  const seen = new Set();
  const parts = String(process.env[key] || "")
    .split(path.delimiter)
    .filter((p) => {
      const norm = p.trim().replace(/[\\/]+$/, "").toLowerCase();
      if (!norm || seen.has(norm) || /[\\/]node_modules[\\/]\.bin$/.test(norm) || /node-gyp-bin$/.test(norm)) return false;
      seen.add(norm);
      return true;
    });
  return { ...process.env, [key]: parts.join(path.delimiter) };
})();

function run(cmd, cmdArgs, options = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: repo, stdio: options.capture ? "pipe" : "inherit", encoding: "utf8", shell: options.shell ?? false, env: options.env ?? stepEnv });
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
// Optional: the Chief Google app's Desktop OAuth client ("Google on this PC"). Named but missing is a mistake, not a choice.
if (local.googleClient && !existsSync(local.googleClient)) notFound.push("googleClient");

const desktopPkg = path.join(repo, "apps", "desktop", "package.json");
const desktopLock = path.join(repo, "apps", "desktop", "package-lock.json");
const current = JSON.parse(readFileSync(desktopPkg, "utf8")).version;
const bump = (v) => v.split(".").map((n, i) => (i === 2 ? Number(n) + 1 : Number(n))).join(".");
const version = opt("promote") || opt("version") || bump(current);
const channel = opt("channel") || "everyone";
if (!["early", "everyone"].includes(channel)) fail(`--channel is "early" or "everyone" (got ${channel}).`);
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

// The payload is the one this repository describes: its patches, its package selection, and no file changed since
// the build (packaging/payload/provenance.py; about a minute for the whole payload). Returns the tree digest.
function payloadProvenance() {
  const r = spawnSync("python", ["packaging/payload/provenance.py", "--payload", local.payloadDir, "--check", "--json"], { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) return { error: (r.stderr || r.stdout || "the provenance check failed").trim() };
  return { tree: JSON.parse(r.stdout).tree };
}

if (flag("plan")) {
  console.log(`Current version ${current} → next ${version}`);
  const mismatch = hermesMismatch();
  if (mismatch) console.log(`   ← ${mismatch}`);
  const prov = payloadProvenance();
  console.log(prov.error ? `Payload provenance: ${prov.error}` : `Payload provenance: matches (tree ${prov.tree.slice(0, 12)})`);
  console.log(`Branch: ${branch}${dirty ? " (uncommitted changes: commit them before releasing)" : " (clean)"}`);
  console.log(`Dev server: ${(await devServer()) ? "RUNNING (stop it first: it shares the build folder)" : "stopped"}`);
  for (const k of need) console.log(`  ${k}: ${local[k]}${notFound.includes(k) ? "   ← NOT FOUND" : ""}`);
  console.log(`  testerCert: ${local.testerCert ? local.testerCert + (existsSync(local.testerCert) ? "" : "   ← NOT FOUND") : "(none: no tester setup zip)"}`);
  console.log(`  googleClient: ${local.googleClient ? local.googleClient + (existsSync(local.googleClient) ? "" : "   ← NOT FOUND") : "(none: Google connects through Quick only)"}`);
  const gh = run("gh", ["repo", "view", local.releasesRepo, "--json", "visibility"], { capture: true, allowFail: true });
  console.log(`Releases repository: ${gh.status === 0 ? JSON.parse(gh.stdout).visibility.toLowerCase() + ", reachable with your gh login" : "NOT reachable (gh auth login?)"}`);
  process.exit(notFound.length || mismatch || prov.error || gh.status !== 0 ? 1 : 0);
}

if (opt("promote")) {
  // An early release, soaked on the owner's install, becomes the latest release for everyone: the same signed files.
  step(`Promoting ${version} to everyone…`);
  run("node", ["packaging/release/release-tool.mjs", "promote", "--version", version, "--repo", local.releasesRepo], { what: `Promoting ${version}` });
  testerKit({ upload: true });
  updateFile();
  afterRelease();
  console.log(`\n✓ ${version} is now the latest release. Installed apps offer it within a day, or at once with Settings → Backup & updates → Check now.`);
  process.exit(0);
}

const notes = opt("notes") || (opt("notes-file") ? readFileSync(opt("notes-file"), "utf8").trim() : "");
if (!notes) fail('Say what changed: --notes "…" (testers see it on the update card).');
if (notFound.length) fail(`Not found: ${notFound.map((k) => `${k} (${local[k]})`).join(", ")}`);
if (branch !== "main") fail(`Release from main (you're on ${branch}).`);
if (dirty) fail("Commit (or discard) your changes first: a release is built from what's committed.");
if (await devServer()) fail("The dashboard dev server (3100 or 3102) is running; stop it first. It shares apps/web/.next with the build.");
const mismatch = hermesMismatch();
if (mismatch) fail(mismatch);
step("Checking the payload's provenance (about a minute)…");
const provenance = payloadProvenance();
if (provenance.error) fail(provenance.error);
run("git", ["fetch", "-q", "origin"]);
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) fail("main differs from origin/main: pull or push first.");

// ---------------------------------------------------------------- build

if (flag("skip-checks") && !flag("no-publish")) fail("--skip-checks is only for a local build (--no-publish): a published release has passed every check.");
step("Running every check (web, desktop, Python, privacy)…");
if (flag("skip-checks")) console.log("⚠ CHECKS SKIPPED (--skip-checks): this build must not be published.");
else run("npm", ["run", "check"], { shell: true, what: "npm run check" });

// From here on, a failure leaves nothing half-done: the version files go back to what's committed, and a draft
// this run uploaded is deleted. Once the version is pushed and the release is live, there is nothing to undo.
const versionFiles = ["apps/desktop/package.json", "apps/desktop/package-lock.json", "hermes/plugins/chief-dashboard-bridge/plugin.yaml"];
const undo = { files: true, draft: false };
process.on("exit", (code) => {
  if (code === 0) return;
  if (undo.draft) {
    console.error(`\n↩ Deleting the draft release v${version}…`);
    spawnSync("node", ["packaging/release/release-tool.mjs", "drop-draft", "--version", version, "--repo", local.releasesRepo], { cwd: repo, stdio: "inherit" });
  }
  if (undo.files) {
    console.error("↩ Putting the version files back as committed.");
    spawnSync("git", ["checkout", "--", ...versionFiles], { cwd: repo, stdio: "inherit" });
  }
});

step(`Version ${current} → ${version}`);
const pkg = JSON.parse(readFileSync(desktopPkg, "utf8"));
pkg.version = version;
writeFileSync(desktopPkg, JSON.stringify(pkg, null, 2) + "\n");
const lock = JSON.parse(readFileSync(desktopLock, "utf8"));
lock.version = version;
if (lock.packages?.[""]) lock.packages[""].version = version;
writeFileSync(desktopLock, JSON.stringify(lock, null, 2) + "\n");
// The bridge plugin ships inside every app version, so it carries the app's version (Hermes lists it).
const pluginYaml = path.join(repo, "hermes", "plugins", "chief-dashboard-bridge", "plugin.yaml");
writeFileSync(pluginYaml, readFileSync(pluginYaml, "utf8").replace(/^version:.*$/m, `version: ${version}`));

step("Licences: checking what ships, and writing the third-party notices…");
run("node", ["scripts/licenses.mjs", "--check", "--payload", local.payloadDir], { what: "the licence check" });
run("node", ["scripts/licenses.mjs", "--notices", "apps/desktop/build/THIRD_PARTY_NOTICES.md", "--sbom", path.join(local.releasesDir, `sbom-${version}.cdx.json`), "--payload", local.payloadDir], {
  what: "the third-party notices and the bill of materials",
});

step("Building the dashboard…");
run("npm", ["--prefix", "apps/web", "run", "build:standalone"], { shell: true, what: "the dashboard build" });

if (!flag("skip-smoke")) {
  step("Smoke test: the app on a throwaway data folder (boot, a chat, an approval, quit)…");
  run("npm", ["--prefix", "apps/desktop", "run", "build"], { shell: true, what: "the desktop build" });
  run("node", ["scripts/smoke-electron.mjs", "--payload", local.payloadDir], { what: "the Electron smoke test" });
}

step("Building and signing the package (about 5 minutes)…");
const password = readFileSync(local.pfxPasswordFile, "utf8").trim();
rmSync(local.releaseDir, { recursive: true, force: true });
const build = spawnSync("npm", ["run", "dist:msix"], {
  cwd: path.join(repo, "apps", "desktop"),
  shell: true,
  encoding: "utf8",
  env: {
    ...stepEnv, SIGNTOOL_PATH: local.signtool, CHIEF_PAYLOAD_DIR: local.payloadDir, CHIEF_RELEASE_DIR: local.releaseDir, CHIEF_SIGN_PFX: local.pfx, CHIEF_SIGN_PASSWORD: password,
    // A new install already knows where updates come from (the public releases repository: no key needed).
    CHIEF_UPDATE_FEED: `github:${local.releasesRepo}`,
    // Where "Report a problem" e-mails go: this PC's release.local.json only, never the repository.
    ...(local.reportEmail ? { CHIEF_REPORT_EMAIL: String(local.reportEmail) } : {}),
    // Google on this PC: the Chief Google app's client file, packaged beside the payload (never in the repository).
    ...(local.googleClient ? { CHIEF_GOOGLE_CLIENT: String(local.googleClient) } : {}),
  },
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
// The pinned keys (apps/desktop/src/release-key.ts); this PC's private key signs as `releaseKeyId` (default: the first).
const pinnedKeys = [...readFileSync(path.join(repo, "apps", "desktop", "src", "release-key.ts"), "utf8").matchAll(/\{\s*id:\s*"([^"]+)",\s*publicKey:\s*"([^"]+)"/g)].map((m) => ({ id: m[1], publicKey: m[2] }));
const signer = pinnedKeys.find((k) => k.id === (local.releaseKeyId || pinnedKeys[0]?.id));
if (!signer) fail(`No pinned release key with id "${local.releaseKeyId}" in apps/desktop/src/release-key.ts.`);
const highlights = (opt("hermes-highlights") || "").split(";").map((h) => h.trim()).filter(Boolean);
const highlightsFile = path.join(local.releasesDir, `hermes-highlights-${version}.txt`);
if (highlights.length) writeFileSync(highlightsFile, `${highlights.join("\n")}\n`);
run("node", [
  "packaging/release/release-tool.mjs", "make", "--msix", feedPkg, "--version", version, "--key", local.releaseKey, "--key-id", signer.id, "--payload-tree", provenance.tree,
  "--sbom", path.join(local.releasesDir, `sbom-${version}.cdx.json`), "--out", out, "--notes", notesFile, ...(highlights.length ? ["--hermes-highlights", highlightsFile] : []),
]);
// The app checks it against the pinned key it names: so does this (a private key that isn't the pinned one fails here).
run("node", ["packaging/release/release-tool.mjs", "verify", "--dir", out, "--pub", signer.publicKey]);
rmSync(feedPkg, { force: true });

// The zip for a new tester (scripts/tester-kit.mjs), attached to a published release so anyone can install from the
// releases page (the READMEs link it). The release stands even if this step fails.
function testerKit({ upload = false } = {}) {
  if (!local.testerCert) return console.log("\n(No testerCert in release.local.json: skipped the tester setup zip.)");
  step("Making the tester setup zip…");
  const made = run("node", ["scripts/tester-kit.mjs", "--version", version], { allowFail: true });
  const zip = path.join(local.releasesDir, `Chief-Command-Center-setup-${version}.zip`);
  if (!upload || made.status !== 0 || !existsSync(zip)) return;
  step("Attaching the setup zip to the release…");
  const up = run("gh", ["release", "upload", `v${version}`, zip, "--repo", local.releasesRepo, "--clobber"], { allowFail: true });
  if (up.status !== 0) console.log(`⚠ The zip wasn't attached. Attach it by hand: gh release upload v${version} "${zip}" --repo ${local.releasesRepo}`);
}

// "Update Chief.cmd" (scripts/update-file.mjs): the one small file a tester double-clicks to get the newest version,
// attached to every release that reaches everyone. It downloads the release itself, so any copy keeps working. The
// release stands even if this step fails.
function updateFile() {
  step("Making Update Chief.cmd…");
  if (run("node", ["scripts/update-file.mjs"], { allowFail: true }).status !== 0) return;
  // GitHub turns spaces in asset names into dots: give it a dash.
  const named = path.join(local.releasesDir, "Update-Chief.cmd");
  copyFileSync(path.join(local.releasesDir, "Update Chief.cmd"), named);
  const up = run("gh", ["release", "upload", `v${version}`, named, "--repo", local.releasesRepo, "--clobber"], { allowFail: true });
  if (up.status !== 0) console.log(`⚠ Update-Chief.cmd wasn't attached. Attach it by hand: gh release upload v${version} "${named}" --repo ${local.releasesRepo}`);
}

// Optional, this PC only: a command to run after each release that reaches everyone (afterRelease in
// release.local.json, e.g. refreshing an installer kit kept outside the repository). "{version}" is replaced; a
// failure never undoes the release.
function afterRelease() {
  if (!Array.isArray(local.afterRelease) || !local.afterRelease.length) return;
  step("Running afterRelease…");
  const [cmd, ...rest] = local.afterRelease.map((a) => String(a).replaceAll("{version}", version));
  const after = run(cmd, rest, { allowFail: true });
  if (after.status !== 0) console.log(`⚠ afterRelease failed (exit ${after.status}); the release itself is done.`);
}

if (flag("no-publish")) {
  testerKit();
  // A local build doesn't move the committed version.
  run("git", ["checkout", "--", ...versionFiles]);
  console.log(`\n✓ Built ${version} (not published; the committed version stays ${current}): ${out}`);
  process.exit(0);
}

// 1. Upload everything as a draft: installed apps can't see it yet, and a failed upload changes nothing.
step(`Uploading ${version} to ${local.releasesRepo} as a draft…`);
undo.draft = true;
run("node", ["packaging/release/release-tool.mjs", "publish", "--dir", out, "--repo", local.releasesRepo, "--draft"]);

// 2. Record the version in the repository: a commit and a tag, pushed.
step("Committing and tagging the version…");
run("git", ["add", ...versionFiles]);
run("git", ["commit", "-q", "-m", `Release ${version}\n\n${notes}`]);
undo.files = false; // committed: from here a failure undoes the commit instead
run("git", ["tag", "-a", `v${version}`, "-m", `Chief Command Center ${version}`]);
const pushed = run("git", ["push", "-q", "--atomic", "origin", "main", `v${version}`], { allowFail: true });
if (pushed.status !== 0) {
  run("git", ["tag", "-d", `v${version}`], { allowFail: true });
  run("git", ["reset", "-q", "--soft", "HEAD~1"], { allowFail: true });
  undo.files = true;
  fail("Pushing the version failed, so the release commit and tag were undone locally and the draft is deleted. Pull, then release again.");
}

// 3. Make it live. The version is pushed now, so a failure here keeps the draft for finishing by hand. An early
// release goes live as a prerelease: only apps with Early updates on are offered it.
undo.draft = false;
const early = channel === "early";
step(early ? `Publishing ${version} as an early release…` : `Publishing ${version}…`);
run("node", ["packaging/release/release-tool.mjs", "undraft", "--version", version, "--repo", local.releasesRepo, ...(early ? ["--prerelease"] : [])], {
  what: `Making the draft live (the version is pushed; finish with: node packaging/release/release-tool.mjs undraft --version ${version} --repo ${local.releasesRepo}${early ? " --prerelease" : ""})`,
});
if (early) {
  console.log(`\n✓ Released ${version} as an early release: an app with Early updates on gets it now. When it has run well for a day or two: npm run release:promote -- ${version}`);
  process.exit(0);
}
testerKit({ upload: true });
updateFile();
afterRelease();
console.log(`\n✓ Released ${version}. Installed apps offer it within a day, or at once with Settings → Backup & updates → Check now.`);
