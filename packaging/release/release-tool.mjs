#!/usr/bin/env node
// Release manifests for the updater (PLAN §8 "Release manifest"). Maintainer-only; the private key never
// enters the repo or CI logs.
//
//   node release-tool.mjs keygen <private key out (outside the repo)>
//       Makes an Ed25519 key pair; prints the public key to pin in apps/desktop/src/release-key.ts.
//   node release-tool.mjs make --msix <file> --version <x.y.z> --key <private key> --out <release folder>
//       [--notes <file>] [--min-reader <x.y.z>] [--data-schema <n>] [--key-id <id of the pinned key it matches>]
//       [--payload-tree <sha256 from provenance.py>] [--sbom <CycloneDX file from scripts/licenses.mjs>]
//       [--hermes-highlights <file: up to three short lines, "New in Hermes" after an update that moved Hermes>]
//       Copies the MSIX into the folder and writes release.json (versions, digests, data compatibility)
//       plus release.json.sig (Ed25519 over the exact bytes of release.json).
//   node release-tool.mjs verify --dir <release folder> --pub <base64 SPKI>
//   node release-tool.mjs publish --dir <release folder> --repo <owner/releases-repo> [--draft (last)]
//       Uploads release.json, its signature and the package as GitHub release v<version> (marked latest) in the
//       private releases repository the app's updater reads with a per-person key. Uses the `gh` CLI's login.
//       With --draft it stays a draft (read-only keys can't see it) until:
//   node release-tool.mjs undraft --version <x.y.z> --repo <owner/releases-repo> [--prerelease (last)]
//       --prerelease: live, but as a prerelease (an early release: only apps with Early updates on are offered it)
//   node release-tool.mjs promote --version <x.y.z> --repo <owner/releases-repo>
//       An early (prerelease) release becomes the latest release for everyone; its files are untouched.
//   node release-tool.mjs drop-draft --version <x.y.z> --repo <owner/releases-repo>   (only ever deletes a draft)
import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..", "..");
const [command, ...rest] = process.argv.slice(2);
const opts = {};
for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, "")] = rest[i + 1];

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

function pinJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

async function make() {
  for (const k of ["msix", "version", "key", "out"]) if (!opts[k]) throw new Error(`--${k} is required`);
  if (!/^\d+\.\d+\.\d+$/.test(opts.version)) throw new Error("--version must be x.y.z");
  const pin = pinJson(path.join(repo, "hermes", "pin.json"));
  const desktop = pinJson(path.join(repo, "apps", "desktop", "package.json"));
  const bridge = readFileSync(path.join(repo, "hermes", "plugins", "chief-dashboard-bridge", "plugin.yaml"), "utf8").match(/^version:\s*(\S+)/m)?.[1] || "";
  mkdirSync(opts.out, { recursive: true });
  const name = `ChiefCommandCenter-${opts.version}.msix`;
  const target = path.join(opts.out, name);
  if (path.resolve(opts.msix) !== path.resolve(target)) copyFileSync(opts.msix, target);
  let sbom = null;
  if (opts.sbom) {
    const file = `ChiefCommandCenter-${opts.version}.cdx.json`;
    copyFileSync(opts.sbom, path.join(opts.out, file));
    sbom = { file, sha256: await sha256(path.join(opts.out, file)) };
  }
  // Up to three short lines; the app shows them once after the update, under "New in Hermes".
  const highlights = opts["hermes-highlights"]
    ? readFileSync(opts["hermes-highlights"], "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 3).map((l) => l.slice(0, 120))
    : [];
  const patches = await Promise.all(
    (pin.patches || []).map(async (p) => ({ file: p.file, sha256: await sha256(path.join(repo, "hermes", "patches", p.file)), upstream: p.upstream || "" })),
  );
  const manifest = {
    format: "chief-release",
    format_version: 1,
    version: opts.version,
    published: new Date().toISOString(),
    notes: opts.notes ? readFileSync(opts.notes, "utf8") : "",
    package: { file: name, bytes: statSync(target).size, sha256: await sha256(target) },
    electron: String(desktop.devDependencies?.electron || ""),
    hermes: { upstream: pin.upstream || "", commit: pin.commit || "", base_version: pin.baseVersion || "", patches, ...(highlights.length ? { highlights } : {}) },
    plugins: { "chief-dashboard-bridge": bridge },
    data: { schema: Number(opts["data-schema"] || 1), min_reader: opts["min-reader"] || opts.version },
    ...(opts["key-id"] ? { signing: { key_id: opts["key-id"] } } : {}),
    // The payload's tree digest (packaging/payload/provenance.py), so a release says exactly which Hermes files it carries.
    ...(opts["payload-tree"] ? { payload: { tree: opts["payload-tree"] } } : {}),
    // The bill of materials ships beside the package; its digest here puts it under the release signature.
    ...(sbom ? { sbom } : {}),
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const key = createPrivateKey(readFileSync(opts.key));
  writeFileSync(path.join(opts.out, "release.json"), bytes);
  writeFileSync(path.join(opts.out, "release.json.sig"), sign(null, bytes, key).toString("base64") + "\n");
  console.log(`release ${opts.version}: ${target} (${manifest.package.bytes} bytes, sha256 ${manifest.package.sha256})`);
}

function keygen() {
  const out = rest[0];
  if (!out) throw new Error("usage: keygen <private key file outside the repo>");
  if (path.resolve(out).startsWith(repo)) throw new Error("Keep the private key outside the repository.");
  if (existsSync(out)) throw new Error(`${out} exists; refusing to overwrite a release key.`);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  console.log(publicKey.export({ type: "spki", format: "der" }).toString("base64"));
}

function verifyDir() {
  const bytes = readFileSync(path.join(opts.dir, "release.json"));
  const sig = Buffer.from(readFileSync(path.join(opts.dir, "release.json.sig"), "utf8").trim(), "base64");
  const key = createPublicKey({ key: Buffer.from(opts.pub, "base64"), format: "der", type: "spki" });
  const ok = verify(null, bytes, key, sig);
  console.log(ok ? "signature ok" : "BAD SIGNATURE");
  process.exit(ok ? 0 : 1);
}

function publish() {
  for (const k of ["dir", "repo"]) if (!opts[k]) throw new Error(`--${k} is required`);
  const release = JSON.parse(readFileSync(path.join(opts.dir, "release.json"), "utf8"));
  const files = ["release.json", "release.json.sig", release.package.file, ...(release.sbom?.file ? [release.sbom.file] : [])].map((f) => path.join(opts.dir, f));
  for (const f of files) if (!existsSync(f)) throw new Error(`missing ${f}`);
  // --draft: uploaded but invisible to the updater (read-only keys can't see drafts) until `undraft`.
  const draft = rest.includes("--draft");
  const args = ["release", "create", `v${release.version}`, ...files, "--repo", opts.repo, "--title", `Chief Command Center ${release.version}`,
    "--notes", release.notes || `Chief Command Center ${release.version}`, ...(draft ? ["--draft"] : ["--latest"])];
  const run = spawnSync("gh", args, { stdio: "inherit", shell: false });
  if (run.status !== 0) throw new Error(`gh release create failed (${run.status})`);
}

/**
 * A draft made by `publish --draft` becomes the latest release (what installed apps are offered), or with
 * --prerelease a live prerelease, which GitHub never makes the latest (so only early-updates apps see it).
 */
function undraft() {
  for (const k of ["version", "repo"]) if (!opts[k]) throw new Error(`--${k} is required`);
  const early = rest.includes("--prerelease");
  const run = spawnSync("gh", ["release", "edit", `v${opts.version}`, "--repo", opts.repo, "--draft=false", ...(early ? ["--prerelease", "--latest=false"] : ["--latest"])], { stdio: "inherit", shell: false });
  if (run.status !== 0) throw new Error(`gh release edit failed (${run.status})`);
}

/** An early release (a live prerelease) becomes the latest release for everyone. A draft is refused. */
function promote() {
  for (const k of ["version", "repo"]) if (!opts[k]) throw new Error(`--${k} is required`);
  const view = spawnSync("gh", ["release", "view", `v${opts.version}`, "--repo", opts.repo, "--json", "isDraft,isPrerelease"], { encoding: "utf8", shell: false });
  if (view.status !== 0) throw new Error(`v${opts.version} isn't in ${opts.repo}.`);
  const state = JSON.parse(view.stdout);
  if (state.isDraft) throw new Error(`v${opts.version} is still a draft; finish its release first (undraft --prerelease).`);
  if (!state.isPrerelease) console.log(`v${opts.version} already reaches everyone; making sure it's the latest.`);
  const run = spawnSync("gh", ["release", "edit", `v${opts.version}`, "--repo", opts.repo, "--prerelease=false", "--latest"], { stdio: "inherit", shell: false });
  if (run.status !== 0) throw new Error(`gh release edit failed (${run.status})`);
}

/** Remove a draft this release run made (a later step failed); a published release is never touched. */
function dropDraft() {
  for (const k of ["version", "repo"]) if (!opts[k]) throw new Error(`--${k} is required`);
  const view = spawnSync("gh", ["release", "view", `v${opts.version}`, "--repo", opts.repo, "--json", "isDraft"], { encoding: "utf8", shell: false });
  if (view.status !== 0) return; // nothing there
  if (!JSON.parse(view.stdout).isDraft) throw new Error(`v${opts.version} is already published; not deleting it.`);
  const run = spawnSync("gh", ["release", "delete", `v${opts.version}`, "--repo", opts.repo, "--yes"], { stdio: "inherit", shell: false });
  if (run.status !== 0) throw new Error(`gh release delete failed (${run.status})`);
}

try {
  if (command === "keygen") keygen();
  else if (command === "publish") publish();
  else if (command === "undraft") undraft();
  else if (command === "promote") promote();
  else if (command === "drop-draft") dropDraft();
  else if (command === "make") await make();
  else if (command === "verify") verifyDir();
  else throw new Error("commands: keygen | make | verify | publish");
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
