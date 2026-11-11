// packaging/release/release-tool.mjs: the signed release description and what `verify` checks before a release ships.
// Run: node --test "scripts/tests/*.test.mjs"
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..", "..");
const tool = path.join(repo, "packaging", "release", "release-tool.mjs");
const run = (...args) => spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** A key pair and a release made with it, in a throwaway folder outside the repository. */
function release(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "chief-release-tool-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, "keys", "release.pem");
  const keygen = run("keygen", key);
  assert.equal(keygen.status, 0, keygen.stderr);
  const msix = path.join(dir, "package.msix");
  writeFileSync(msix, "a stand-in for the package");
  const sbom = path.join(dir, "sbom.cdx.json");
  writeFileSync(sbom, '{"bomFormat": "CycloneDX"}\n');
  const out = path.join(dir, "out");
  const made = run("make", "--msix", msix, "--version", "1.2.3", "--key", key, "--out", out, "--sbom", sbom);
  assert.equal(made.status, 0, made.stderr);
  return { dir, key, pub: keygen.stdout.trim(), out, pkg: path.join(out, "ChiefCommandCenter-1.2.3.msix") };
}

test("a release describes its package and bill of materials exactly, and verifies", (t) => {
  const { pub, out, pkg } = release(t);
  const manifest = JSON.parse(readFileSync(path.join(out, "release.json"), "utf8"));
  const pin = JSON.parse(readFileSync(path.join(repo, "hermes", "pin.json"), "utf8"));
  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual(manifest.package, { file: "ChiefCommandCenter-1.2.3.msix", bytes: readFileSync(pkg).length, sha256: sha256(pkg) });
  assert.equal(manifest.sbom.sha256, sha256(path.join(out, manifest.sbom.file)));
  assert.equal(manifest.hermes.base_version, pin.baseVersion);
  assert.deepEqual(
    manifest.hermes.patches.map((p) => p.file),
    pin.patches.map((p) => p.file),
  );
  const verified = run("verify", "--dir", out, "--pub", pub);
  assert.equal(verified.status, 0, verified.stdout + verified.stderr);
  assert.match(verified.stdout, /signature ok/);
  assert.match(verified.stdout, /ChiefCommandCenter-1\.2\.3\.msix matches/);
  assert.match(verified.stdout, /ChiefCommandCenter-1\.2\.3\.cdx\.json matches/);
});

test("verify refuses a package that isn't the one the release describes", (t) => {
  const { pub, out, pkg } = release(t);
  const original = readFileSync(pkg);
  writeFileSync(pkg, Buffer.from(original.toString("utf8").replace("stand-in", "swapped!"), "utf8"));
  assert.equal(readFileSync(pkg).length, original.length); // the same size, other bytes
  const swapped = run("verify", "--dir", out, "--pub", pub);
  assert.equal(swapped.status, 1);
  assert.match(swapped.stdout, /signature ok/);
  assert.match(swapped.stderr, /doesn't match release\.json's sha256/);
  writeFileSync(pkg, Buffer.concat([original, Buffer.from("more")]));
  assert.match(run("verify", "--dir", out, "--pub", pub).stderr, /isn't the size release\.json says/);
  unlinkSync(pkg);
  assert.match(run("verify", "--dir", out, "--pub", pub).stderr, /isn't beside release\.json/);
});

test("verify refuses a changed bill of materials", (t) => {
  const { pub, out } = release(t);
  writeFileSync(path.join(out, "ChiefCommandCenter-1.2.3.cdx.json"), '{"bomFormat": "something else"}\n');
  const r = run("verify", "--dir", out, "--pub", pub);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cdx\.json doesn't match/);
});

test("verify refuses a description changed after signing, or signed by another key", (t) => {
  const { dir, pub, out } = release(t);
  const other = run("keygen", path.join(dir, "keys", "other.pem")).stdout.trim();
  const wrongKey = run("verify", "--dir", out, "--pub", other);
  assert.equal(wrongKey.status, 1);
  assert.match(wrongKey.stdout, /BAD SIGNATURE/);
  const file = path.join(out, "release.json");
  writeFileSync(file, readFileSync(file, "utf8").replace('"version": "1.2.3"', '"version": "1.2.4"'));
  const changed = run("verify", "--dir", out, "--pub", pub);
  assert.equal(changed.status, 1);
  assert.match(changed.stdout, /BAD SIGNATURE/);
});

test("make checks what it is given", (t) => {
  const { dir, key } = release(t);
  const msix = path.join(dir, "package.msix");
  assert.match(run("make", "--msix", msix, "--key", key, "--out", path.join(dir, "a")).stderr, /--version is required/);
  assert.match(run("make", "--msix", msix, "--version", "1.2", "--key", key, "--out", path.join(dir, "b")).stderr, /--version must be x\.y\.z/);
  assert.equal(existsSync(path.join(dir, "b", "release.json")), false);
});

test("keygen keeps the private key out of the repository and never replaces one", (t) => {
  const { key } = release(t);
  const inside = path.join(repo, "release-tool-test-key.pem");
  const refused = run("keygen", inside);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /outside the repository/);
  assert.equal(existsSync(inside), false);
  const before = readFileSync(key, "utf8");
  assert.match(run("keygen", key).stderr, /refusing to overwrite/);
  assert.equal(readFileSync(key, "utf8"), before);
});
