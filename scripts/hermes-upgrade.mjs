#!/usr/bin/env node
// One command for the local half of a Hermes upgrade (CLAUDE.md "Hermes updates"; docs/PLAN-2026-10-07 §3.5), after
// the "Upgrade Hermes to <tag>" PR is merged and pulled:
//
//   npm run hermes:upgrade                 (the version hermes/pin.json names)
//   node scripts/hermes-upgrade.mjs [--python <3.14 python.exe>] [--allow-dirty] [--keep-going] [--rebuild]
//
// 1. Refuses an uncommitted tree (a payload's provenance records the builder commit; `dirty: true` is a payload
//    nobody can rebuild). 2. Prepares the pinned source into <build>\hermes-src-<version> (patch queue applied).
// 3. Builds the payload into <build>\payload-<version> with a Python 3.14 (stage.py needs the payload's own version):
//    --python, or <build>\py314, or a venv made there from the current payload's own interpreter. 4. Runs the
//    compatibility suite (report beside the payload). 5. Points release.local.json's payloadDir at the new payload
//    (the old one stays on disk as the fallback, and is kept as previousPayloadDir) and prints the release command.
//
// <build> is the folder holding the current payloadDir. Re-running continues: a prepared source or a finished payload
// for the same commit is reused.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);
const fail = (m) => {
  console.error(`\n✗ ${m}`);
  process.exit(1);
};
const step = (m) => console.log(`\n▶ ${m}`);
const run = (cmd, cmdArgs, what, options = {}) => {
  const r = spawnSync(cmd, cmdArgs, { cwd: repo, stdio: options.capture ? "pipe" : "inherit", encoding: "utf8", env: options.env ?? process.env });
  if (r.status !== 0 && !options.allowFail) fail(`${what} failed (exit ${r.status}).`);
  return r;
};

const localFile = path.join(repo, "release.local.json");
if (!existsSync(localFile)) fail(`Missing ${localFile} (see release.local.example.json).`);
const local = JSON.parse(readFileSync(localFile, "utf8"));
const pin = JSON.parse(readFileSync(path.join(repo, "hermes", "pin.json"), "utf8"));
const version = pin.baseVersion;
const build = path.dirname(local.payloadDir);
const src = path.join(build, `hermes-src-${version}`);
const payload = path.join(build, `payload-${version}`);
const cache = path.join(build, "uv-cache");
console.log(`Hermes ${version} (${pin.commit.slice(0, 10)}): source ${src}, payload ${payload}`);

const stampOf = (dir) => {
  try {
    return JSON.parse(readFileSync(path.join(dir, "hermes-agent", "install-stamp.json"), "utf8"));
  } catch {
    return {};
  }
};
if (stampOf(local.payloadDir).upstreamCommit === pin.commit && !flag("rebuild")) {
  console.log(`\n✓ The payload release.local.json points at (${local.payloadDir}) already holds this Hermes. Nothing to do (--rebuild to build it again).`);
  process.exit(0);
}

const dirty = run("git", ["status", "--porcelain"], "git status", { capture: true }).stdout.trim();
if (dirty && !flag("allow-dirty")) fail("Commit (or stash) your changes first: the payload records the commit it was built from.");

// The payload's stamp names the upstream commit it holds: a finished payload for this pin is reused.
const built = stampOf(payload).upstreamCommit === pin.commit;

if (!built) {
  step("Preparing the pinned source with the patch queue…");
  run("python", ["packaging/payload/prepare_source.py", "--dest", src], "prepare_source.py (a patch that no longer applies is named above: refresh it as a next form)");

  step("Finding a Python 3.14 for the build…");
  let python = opt("python") || path.join(build, "py314", "Scripts", "python.exe");
  if (!existsSync(python)) {
    const manifest = JSON.parse(readFileSync(path.join(local.payloadDir, "manifest.json"), "utf8")).runtime;
    const own = path.join(local.payloadDir, manifest.storePython);
    console.log(`No 3.14 venv yet: making ${path.dirname(path.dirname(python))} from the current payload's own Python.`);
    run("uv", ["venv", "--python", own, path.dirname(path.dirname(python))], "uv venv");
    run("uv", ["pip", "install", "--python", python, "pyyaml", "cryptography", "requests"], "installing the build's packages");
  }
  const v = run(python, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], "the 3.14 python", { capture: true }).stdout.trim();
  if (v !== "3.14") fail(`${python} is Python ${v}; stage.py needs 3.14.`);

  step("Building the payload (this takes a while; it downloads Python, Node, Git and packages into the cache)…");
  run(python, ["packaging/payload/stage.py", "--hermes-src", src, "--out", payload, "--cache", cache], "stage.py");
} else console.log("The payload for this pin is already built; checking it again.");

step("Running the compatibility suite…");
const report = path.join(build, `compat-${version}.md`);
const compat = run("python", ["packaging/upstream/compat.py", "--payload", payload, "--work", path.join(build, `compat-${version}`), "--report", report], "compat.py", { allowFail: true });
if (compat.status !== 0 && !flag("keep-going")) fail(`The compatibility suite failed: ${report}. Fix it before releasing (or --keep-going to point at the payload anyway).`);

step("Pointing release.local.json at the new payload…");
if (path.resolve(local.payloadDir) !== path.resolve(payload)) {
  local.previousPayloadDir = local.payloadDir;
  local.payloadDir = payload;
  writeFileSync(localFile, `${JSON.stringify(local, null, 2)}\n`);
  console.log(`payloadDir → ${payload} (the previous one, ${local.previousPayloadDir}, stays as the fallback)`);
} else console.log("payloadDir already points there.");

console.log(`
✓ Hermes ${version} is ready to ship. Next, an early release for your own install first:

    npm run release -- --channel early --notes "Hermes moved to ${version}: <the highlights from the upgrade PR's feature radar>"

Use it for a day or two (Settings → Backup & updates → Early updates on), then: npm run release:promote -- <version>`);
