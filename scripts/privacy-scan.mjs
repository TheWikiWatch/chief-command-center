#!/usr/bin/env node
// Fails when files that would be published contain personal data.
//
// Built-in checks: e-mail addresses, Windows/POSIX home-folder paths with a real user name, and
// secret-looking tokens. Personal words (names, handles, private folder names) come from a list that
// is never committed: `.privacy-denylist` next to this repo (one entry per line), or the
// PRIVACY_DENYLIST environment variable (comma or newline separated) in CI.
//
//   node scripts/privacy-scan.mjs            scan the files git would publish (tracked + untracked, not ignored)
//   node scripts/privacy-scan.mjs --history  also scan every commit's contents
//   node scripts/privacy-scan.mjs --history --range A..B   only the commits in that range (CI: a push or a PR)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 });

const denyFile = path.join(root, ".privacy-denylist");
const words = [
  ...(existsSync(denyFile) ? readFileSync(denyFile, "utf8").split(/\r?\n/) : []),
  ...String(process.env.PRIVACY_DENYLIST || "").split(/[,\r\n]/),
]
  .map((w) => w.trim())
  .filter((w) => w && !w.startsWith("#"));

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Placeholder user names that may appear in documentation and tests.
const PLACEHOLDER_USERS = /^(you|user|username|name|me|runner|example|\.{3}|…|<[^>]+>|%[A-Z_]+%|\$\{?[A-Za-z_]+\}?)$/i;

const checks = [
  {
    name: "e-mail address",
    // The local part starts with a letter or digit, so decorators like `+@pytest.mark` don't count.
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    allow: (m) => /@(example\.(com|org|net)|localhost|users\.noreply\.github\.com|anthropic\.com)$/i.test(m) || /^(noreply|no-reply)@/i.test(m),
  },
  {
    name: "home folder path",
    re: /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/(?:home|Users)\/)([^\\/\s"'`<>]+)/g,
    allow: (_m, user) => PLACEHOLDER_USERS.test(user),
  },
  { name: "secret-looking token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{24,}|xox[abp]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g },
  ...(words.length ? [{ name: "personal word", re: new RegExp(`(?<![A-Za-z0-9])(?:${words.map(escape).join("|")})(?![A-Za-z0-9])`, "gi") }] : []),
];

const SKIP = /(^|\/)(package-lock\.json|.*\.(png|jpe?g|gif|webp|ico|woff2?|ttf|pdf|zip|mp3|mp4|wav))$/i;

function scanText(label, text, findings) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const check of checks) {
      check.re.lastIndex = 0;
      for (const m of line.matchAll(check.re)) {
        if (check.allow?.(m[0], m[1])) continue;
        findings.push(`${label}:${i + 1}: ${check.name}: ${m[0].slice(0, 80)}`);
      }
    }
  });
}

const findings = [];
const files = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean);
for (const file of files) {
  if (SKIP.test(file) || file === ".privacy-denylist") continue;
  const full = path.join(root, file);
  if (!existsSync(full)) continue;
  scanText(file, readFileSync(full, "utf8"), findings);
}

const rangeAt = process.argv.indexOf("--range");
const range = rangeAt >= 0 ? process.argv[rangeAt + 1] || "" : "";
if (process.argv.includes("--history")) {
  let revs = [];
  try {
    // A range whose start isn't known here (a force-push, a first push) falls back to the whole history.
    let known = true;
    if (range) {
      try {
        git("rev-parse", "--verify", "--quiet", `${range.split("..")[0]}^{commit}`);
      } catch {
        known = false;
      }
    }
    revs = git("rev-list", ...(range && known ? [range] : ["--all"])).split(/\s+/).filter(Boolean);
  } catch {
    /* no commits yet */
  }
  const seen = new Set();
  for (const rev of revs) {
    for (const row of git("ls-tree", "-r", rev).split("\n").filter(Boolean)) {
      const [meta, file] = row.split("\t");
      const blob = meta.split(" ")[2];
      if (seen.has(blob) || SKIP.test(file) || file === ".privacy-denylist") continue;
      seen.add(blob);
      scanText(`${rev.slice(0, 7)}:${file}`, git("cat-file", "-p", blob), findings);
    }
    const message = git("log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B", rev);
    scanText(`${rev.slice(0, 7)}:<commit metadata>`, message, findings);
  }
}

if (!words.length) console.warn("privacy-scan: no personal word list (.privacy-denylist or PRIVACY_DENYLIST); built-in checks only.");
if (findings.length) {
  console.error(`privacy-scan: ${findings.length} finding(s)\n` + findings.join("\n"));
  process.exit(1);
}
console.log(`privacy-scan: clean (${files.length} files${process.argv.includes("--history") ? (range ? ` + commits ${range}` : " + history") : ""}).`);
