#!/usr/bin/env node
// "Update Chief.cmd": one small file to send a tester that updates their app to the newest release, keeping all their
// data (docs/DISTRIBUTION.md, "A tester stuck on an old version"). It downloads the package itself, so the same file
// works for every future release.
//
//   node scripts/update-file.mjs
//
// Fills packaging/tester/update-chief.template.cmd with this PC's releases repository and the publisher certificate's
// fingerprint (release.local.json: releasesRepo, testerCert), and writes <releasesDir>\Update Chief.cmd (CRLF, ASCII).
// scripts/release.mjs runs it after every release that reaches everyone and attaches it to the release.
import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};
const localFile = path.join(repo, "release.local.json");
if (!existsSync(localFile)) fail(`Missing ${localFile}.`);
const local = JSON.parse(readFileSync(localFile, "utf8"));
for (const k of ["releasesRepo", "testerCert", "releasesDir"]) if (!local[k]) fail(`release.local.json lacks ${k}.`);
if (!/^[\w.-]+\/[\w.-]+$/.test(local.releasesRepo)) fail(`releasesRepo isn't owner/repo: ${local.releasesRepo}`);
const fingerprint = new X509Certificate(readFileSync(local.testerCert)).fingerprint.replace(/:/g, "").toUpperCase();

const template = readFileSync(path.join(repo, "packaging", "tester", "update-chief.template.cmd"), "utf8");
const text = template.replaceAll("__REPO__", local.releasesRepo).replaceAll("__FINGERPRINT__", fingerprint);
if (/__[A-Z]+__/.test(text)) fail("a placeholder was left in the file.");
if (/[^\x00-\x7f]/.test(text)) fail("the file must be plain ASCII (cmd and Windows PowerShell 5.1 read it as such).");
const out = path.join(local.releasesDir, "Update Chief.cmd");
writeFileSync(out, text.replace(/\r?\n/g, "\r\n"));
console.log(`wrote ${out} (repository ${local.releasesRepo}, publisher ${fingerprint.slice(0, 8)}…)`);
