// scripts/licenses.mjs: which licences may ship, and the bill of materials a release carries.
// Run: node --test "scripts/tests/*.test.mjs"
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { allowed, sriHashes } from "../licenses.mjs";

const repo = path.resolve(import.meta.dirname, "..", "..");

test("allowed: a licence on the list, any alternative of an OR, every part of an AND", () => {
  for (const ok of ["MIT", "Apache-2.0", "BSD-3-Clause", "MIT OR GPL-3.0-only", "(MIT OR Apache-2.0)", "MIT AND ISC", "Python-2.0 AND (MIT OR Unlicense)"]) {
    assert.equal(allowed(ok), true, ok);
  }
  for (const no of ["", "UNKNOWN", "GPL-3.0-only", "AGPL-3.0-or-later", "MIT AND GPL-3.0-only", "SEE LICENSE IN LICENSE", "mit"]) {
    assert.equal(allowed(no), false, no);
  }
});

test("lockfile integrity values become CycloneDX hashes", () => {
  const sri = (alg, data) => `${alg}-${createHash(alg).update(data).digest("base64")}`;
  const hex = (alg, data) => createHash(alg).update(data).digest("hex");
  assert.deepEqual(sriHashes(sri("sha512", "a")), [{ alg: "SHA-512", content: hex("sha512", "a") }]);
  assert.deepEqual(sriHashes(`${sri("sha1", "b")} ${sri("sha256", "b")}`), [
    { alg: "SHA-1", content: hex("sha1", "b") },
    { alg: "SHA-256", content: hex("sha256", "b") },
  ]);
  assert.deepEqual(sriHashes(""), []);
  assert.deepEqual(sriHashes("md5-AAAA not-a-hash"), []);
});

test("the bill of materials: Electron with its Chromium, a hash for every npm package, one Hermes, a serial number", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "chief-sbom-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A payload with just enough in it: Hermes as the build installs it (0.0.0, from source) and one other package.
  const site = path.join(dir, "payload", "venv", "Lib", "site-packages");
  for (const [folder, name, version] of [
    ["hermes_agent-0.0.0.dist-info", "hermes-agent", "0.0.0"],
    ["example_pkg-1.0.dist-info", "example-pkg", "1.0"],
  ]) {
    mkdirSync(path.join(site, folder), { recursive: true });
    writeFileSync(path.join(site, folder, "METADATA"), `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\nLicense-Expression: MIT\n\nAbout it.\n`);
  }
  mkdirSync(path.join(dir, "payload", "hermes-agent"));
  writeFileSync(path.join(dir, "payload", "hermes-agent", "LICENSE"), "MIT License\n\nPermission is hereby granted, free of charge, to any person.\n");
  const out = path.join(dir, "sbom.cdx.json");
  const r = spawnSync(process.execPath, [path.join(repo, "scripts", "licenses.mjs"), "--sbom", out, "--payload", path.join(dir, "payload")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const bom = JSON.parse(readFileSync(out, "utf8"));
  assert.match(bom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  const pin = JSON.parse(readFileSync(path.join(repo, "hermes", "pin.json"), "utf8"));
  const hermes = bom.components.filter((c) => c.name === "hermes-agent");
  assert.deepEqual(
    hermes.map((c) => [c.version, c.purl]),
    [[pin.baseVersion, `pkg:pypi/hermes-agent@${pin.baseVersion}`]],
  );
  assert.ok(bom.components.some((c) => c.purl === "pkg:pypi/example-pkg@1.0"));

  const lock = JSON.parse(readFileSync(path.join(repo, "apps", "desktop", "package-lock.json"), "utf8")).packages["node_modules/electron"];
  const electron = bom.components.find((c) => c.purl === `pkg:npm/electron@${lock.version}`);
  assert.ok(electron, "Electron ships with the app, though the desktop app lists it as a development dependency");
  assert.deepEqual(electron.hashes, sriHashes(lock.integrity));
  // Only where the Electron binary is downloaded (CI's installs skip it).
  if (existsSync(path.join(repo, "apps", "desktop", "node_modules", "electron", "dist"))) {
    assert.match(electron.components?.[0]?.purl || "", /^pkg:generic\/chromium@\d+\.\d+\.\d+\.\d+$/);
  }
  for (const c of bom.components.filter((c) => c.purl.startsWith("pkg:npm/"))) assert.ok(c.hashes?.length, c.purl);
});
