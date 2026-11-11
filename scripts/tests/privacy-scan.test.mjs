// scripts/privacy-scan.mjs, run on a throwaway repository: what it finds, what it lets through, what it never prints.
// Run: node --test "scripts/tests/*.test.mjs"
// The samples are put together at run time, so this file itself holds none of what the scan looks for.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..", "..");
const git = (cwd, ...args) => spawnSync("git", ["-c", "user.name=Scan Test", "-c", "user.email=scan@example.com", ...args], { cwd, encoding: "utf8" });

function repository(t, files) {
  const dir = mkdtempSync(path.join(tmpdir(), "chief-privacy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "scripts"));
  copyFileSync(path.join(repo, "scripts", "privacy-scan.mjs"), path.join(dir, "scripts", "privacy-scan.mjs"));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  assert.equal(git(dir, "init", "-q").status, 0);
  return dir;
}

function scan(dir, { args = [], denylist = "" } = {}) {
  const r = spawnSync(process.execPath, [path.join(dir, "scripts", "privacy-scan.mjs"), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PRIVACY_DENYLIST: denylist },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const email = ["pat.doe", "mail.test"].join("@");
const home = ["C:", "Users", "patdoe", "Documents", "notes.md"].join("\\");
const token = "gh" + "p_" + "Ab1".repeat(12);
const keyHeader = "-----BEGIN " + "PRIVATE KEY-----";

test("a clean repository passes", (t) => {
  const dir = repository(t, {
    "README.md": `Write to ${["someone", "example.com"].join("@")}; files live in ${["C:", "Users", "<you>", "Chief"].join("\\")}.\n\tIndented with a tab.\r\n`,
  });
  const r = scan(dir);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /privacy-scan: clean/);
});

test("personal data is found, and never shown in full", (t) => {
  const dir = repository(t, {
    "notes.md": `${email}\nopen ${home}\n${token}\n${keyHeader}\nZorblax was here\n`,
    "release.local.json": "{}\n",
  });
  const r = scan(dir, { denylist: "Zorblax" });
  assert.equal(r.status, 1);
  for (const finding of ["notes.md:1: e-mail address", "notes.md:2: home folder path", "notes.md:3: secret-looking token", "notes.md:4: private key", "notes.md:5: personal word"]) {
    assert.ok(r.out.includes(finding), `${finding}\n${r.out}`);
  }
  assert.match(r.out, /release\.local\.json: a key or local setup file/);
  for (const secret of [email, "patdoe", token, "Zorblax"]) assert.ok(!r.out.includes(secret), secret);
});

test("a control character in a text file is refused; a binary file and history aren't read for them", (t) => {
  const backspaced = `bash = r"C:\\Program Files\\Git${"\b"}in${"\b"}ash.exe"\n`;
  const dir = repository(t, {
    "osb_vendor.py": `# fine\n${backspaced}`,
    "picture.bin": Buffer.from([0x89, 0x00, 0x08, 0x1b, 0x7f]),
  });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.out, /osb_vendor\.py:2: control character U\+0008/);
  assert.doesNotMatch(r.out, /picture\.bin/);

  // Once fixed, the old blob still sits in history: only personal data there counts.
  writeFileSync(path.join(dir, "osb_vendor.py"), "# fine\n");
  writeFileSync(path.join(dir, "leak.md"), `${token}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  unlinkSync(path.join(dir, "leak.md"));
  writeFileSync(path.join(dir, "osb_vendor.py"), backspaced);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "second");
  writeFileSync(path.join(dir, "osb_vendor.py"), "# fine\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "third");
  assert.equal(scan(dir).status, 0);
  const history = scan(dir, { args: ["--history"] });
  assert.equal(history.status, 1);
  assert.match(history.out, /:leak\.md:1: secret-looking token/);
  assert.doesNotMatch(history.out, /control character/);
});
