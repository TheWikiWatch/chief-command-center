// packaging/tester/update-chief.template.cmd ("Update Chief.cmd"): the batch part that starts its PowerShell, and what
// the PowerShell asks Windows for. Run: node --test "scripts/tests/*.test.mjs"
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repo = path.resolve(import.meta.dirname, "..", "..");
const templateFile = path.join(repo, "packaging", "tester", "update-chief.template.cmd");
const template = readFileSync(templateFile, "utf8");
const windows = process.platform === "win32";
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

test("it runs from a folder whose name has an apostrophe in it", { skip: !windows && "Windows only" }, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "chief-update-o'brien's files "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The template's own batch part, then a stand-in for the PowerShell that would update Chief.
  const batch = template.slice(0, template.indexOf("#>") + 2);
  const file = path.join(dir, "Update Chief.cmd");
  writeFileSync(file, `${batch}\r\nWrite-Output ("started from " + $env:CHIEF_UPDATE_SCRIPT)\r\n`);
  const r = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", file], { input: "\r\n", encoding: "utf8", windowsHide: true });
  // The folder's own name, apostrophe included (the part before it may be written in its short 8.3 form).
  assert.ok(r.stdout.includes(`${path.basename(dir)}\\Update Chief.cmd`), r.stdout + r.stderr);
});

test("its PowerShell parses in Windows PowerShell 5.1, and it is plain ASCII", { skip: !windows && "Windows only" }, () => {
  assert.doesNotMatch(template, /[^\x00-\x7f]/);
  const check = "$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:CHIEF_TEMPLATE, [ref]$null, [ref]$errors); $errors.Count";
  const r = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", check], { env: { ...process.env, CHIEF_TEMPLATE: templateFile }, encoding: "utf8" });
  assert.equal(r.stdout.trim(), "0", r.stdout + r.stderr);
});

test("only a forced run lets Windows install over the same or a newer version", () => {
  const lines = template.split(/\r?\n/).filter((line) => line.includes("ForceUpdateFromAnyVersion"));
  assert.deepEqual(
    lines.map((line) => line.trim()),
    ["if ($Force) { $extra.ForceUpdateFromAnyVersion = $true }"],
  );
});
