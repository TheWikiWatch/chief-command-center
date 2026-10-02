#!/usr/bin/env node
// What the app ships under whose licence: the dashboard's npm packages, the Hermes payload's Python packages and
// the programs it bundles (ffmpeg, Git, Python, Node…).
//
//   node scripts/licenses.mjs --check [--payload <dir>]            fail on a licence outside the allow-list
//   node scripts/licenses.mjs --notices <out.md> [--payload <dir>]  write the third-party notices (with licence texts)
//
// Without --payload only the npm packages are covered (CI); the release passes the payload. GPL programs (ffmpeg,
// Git) ship as separate executables with their source offered in the notices; GPL code may not be linked into the app.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : "");
const payload = opt("--payload");

// Permissive or weak-copyleft licences fine to ship inside the app (SPDX ids, as package metadata spells them).
const ALLOWED = new Set([
  "MIT", "MIT-0", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "Unlicense", "CC0-1.0", "CC-BY-4.0", "Zlib",
  "MPL-2.0", "LGPL-2.1-or-later", "LGPL-3.0-or-later", "LGPL-2.1-only", "LGPL-3.0-only", "Python-2.0", "PSF-2.0",
  "Artistic-2.0", "BlueOak-1.0.0", "HPND", "MIT-CMU", "BSL-1.0", "Unicode-3.0", "Unicode-DFS-2016", "OFL-1.1",
]);

/** The bundled programs (payload tools/<name>-<version>-…): separate executables, some GPL, source linked. */
const TOOLS = {
  ffmpeg: { license: "GPL-3.0-or-later", source: "https://ffmpeg.org/download.html#get-sources" },
  git: { license: "GPL-2.0-only", source: "https://github.com/git-for-windows/git" },
  python: { license: "PSF-2.0", source: "https://www.python.org/downloads/source/" },
  node: { license: "MIT", source: "https://github.com/nodejs/node" },
  npm: { license: "Artistic-2.0", source: "https://github.com/npm/cli" },
  uv: { license: "MIT OR Apache-2.0", source: "https://github.com/astral-sh/uv" },
  ripgrep: { license: "MIT OR Unlicense", source: "https://github.com/BurntSushi/ripgrep" },
};

// Spellings package metadata uses for SPDX ids (compared case-insensitively).
const ALIASES = {
  "mit license": "MIT", "the mit license": "MIT", "apache license 2.0": "Apache-2.0", "apache 2.0": "Apache-2.0", "apache software license": "Apache-2.0",
  "3-clause bsd license": "BSD-3-Clause", "bsd license": "BSD-3-Clause", "new bsd license": "BSD-3-Clause", "bsd": "BSD-3-Clause", "psf": "PSF-2.0", "isc license": "ISC",
};

// Reviewed by hand: packages whose metadata doesn't say (the licence of their source repository).
const REVIEWED = {
  "fal-client": "Apache-2.0", // github.com/fal-ai/fal, LICENSE
  "@paper-design/shaders": "MIT", // package.json says "SEE LICENSE IN …"; the LICENSE is MIT
  "@paper-design/shaders-react": "MIT",
  khroma: "MIT", // no license field; its license file is MIT
};

function normalize(name, license) {
  const reviewed = REVIEWED[String(name).toLowerCase().replace(/_/g, "-")];
  if (reviewed && (!license || license === "UNKNOWN" || /^SEE LICENSE/i.test(license))) return reviewed;
  return ALIASES[String(license).toLowerCase().trim()] || license;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|rst))?$/i;

function guessFromText(text) {
  if (/MIT License|Permission is hereby granted, free of charge/i.test(text)) return "MIT";
  if (/Apache License,? Version 2\.0/i.test(text)) return "Apache-2.0";
  if (/Redistribution and use in source and binary forms/i.test(text)) return /Neither the name/i.test(text) ? "BSD-3-Clause" : "BSD-2-Clause";
  if (/ISC License|Permission to use, copy, modify, and\/or distribute/i.test(text)) return "ISC";
  return "";
}

/** "MIT OR Apache-2.0" → allowed if any alternative is; "A AND B" → allowed if all are. */
export function allowed(expr) {
  const clean = String(expr || "").replace(/[()]/g, " ").trim();
  if (!clean) return false;
  if (/\sOR\s/i.test(clean)) return clean.split(/\s+OR\s+/i).some((part) => allowed(part));
  if (/\sAND\s/i.test(clean)) return clean.split(/\s+AND\s+/i).every((part) => allowed(part));
  return ALLOWED.has(clean.trim());
}

function readLicenseText(dir) {
  try {
    const name = readdirSync(dir).find((f) => LICENSE_FILE.test(f));
    return name ? readFileSync(path.join(dir, name), "utf8") : "";
  } catch {
    return "";
  }
}

function npmPackages() {
  const out = [];
  for (const app of ["apps/web", "apps/desktop"]) {
    const lockFile = path.join(repo, app, "package-lock.json");
    if (!existsSync(lockFile)) continue;
    const lock = JSON.parse(readFileSync(lockFile, "utf8"));
    for (const [key, info] of Object.entries(lock.packages || {})) {
      if (!key || info.dev || info.devOptional) continue;
      const name = key.replace(/^.*node_modules\//, "");
      const dir = path.join(repo, app, key);
      const text = readLicenseText(dir);
      let license = typeof info.license === "string" ? info.license : "";
      if (!license || /^SEE LICENSE/i.test(license)) license = guessFromText(text) || license || "UNKNOWN";
      out.push({ kind: "npm", name, version: info.version || "", license: normalize(name, license), text });
    }
  }
  return dedupe(out);
}

function pythonPackages(root) {
  const site = path.join(root, "venv", "Lib", "site-packages");
  if (!existsSync(site)) return [];
  const out = [];
  for (const entry of readdirSync(site)) {
    if (!entry.endsWith(".dist-info")) continue;
    const dir = path.join(site, entry);
    let meta = "";
    try {
      meta = readFileSync(path.join(dir, "METADATA"), "utf8");
    } catch {
      continue;
    }
    const header = meta.split(/\r?\n\r?\n/)[0];
    const field = (name) => (header.match(new RegExp(`^${name}: (.*)$`, "mi")) || [])[1]?.trim() || "";
    const classifiers = [...header.matchAll(/^Classifier: License :: OSI Approved :: (.*)$/gim)].map((m) => m[1].trim());
    const fromClassifier = { "MIT License": "MIT", "BSD License": "BSD-3-Clause", "Apache Software License": "Apache-2.0", "ISC License (ISCL)": "ISC", "Python Software Foundation License": "PSF-2.0", "Mozilla Public License 2.0 (MPL 2.0)": "MPL-2.0", "GNU Lesser General Public License v3 (LGPLv3)": "LGPL-3.0-only", "GNU Lesser General Public License v2 or later (LGPLv2+)": "LGPL-2.1-or-later", "The Unlicense (Unlicense)": "Unlicense" };
    const licensesDir = path.join(dir, "licenses");
    const text = readLicenseText(existsSync(licensesDir) ? licensesDir : dir) || readLicenseText(dir);
    let license = field("License-Expression") || classifiers.map((c) => fromClassifier[c]).filter(Boolean).join(" OR ");
    const raw = field("License");
    if (!license && raw && raw.length < 40) license = { "MIT License": "MIT", BSD: "BSD-3-Clause", "Apache 2.0": "Apache-2.0", "Apache-2.0": "Apache-2.0", "Apache Software License": "Apache-2.0", "BSD-3-Clause": "BSD-3-Clause", MIT: "MIT", ISC: "ISC", "MPL-2.0": "MPL-2.0", PSF: "PSF-2.0" }[raw] || raw;
    if (!license) license = guessFromText(text) || "UNKNOWN";
    out.push({ kind: "python", name: field("Name"), version: field("Version"), license: normalize(field("Name"), license), text });
  }
  return dedupe(out);
}

function tools(root) {
  const dir = path.join(root, "tools");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => {
      const [tool, version] = name.split("-");
      const known = TOOLS[tool];
      return known ? { kind: "program", name: tool, version: version || "", license: known.license, source: known.source, text: readLicenseText(path.join(dir, name)) } : null;
    })
    .filter(Boolean);
}

function dedupe(list) {
  const seen = new Map();
  for (const p of list) seen.set(`${p.kind}:${p.name}@${p.version}`, p);
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const npm = npmPackages();
const py = payload ? pythonPackages(payload) : [];
const programs = payload ? tools(payload) : [];
const hermes = payload ? [{ kind: "python", name: "hermes-agent", version: "", license: "MIT", text: readLicenseText(path.join(payload, "hermes-agent")) }] : [];
const everything = [...npm, ...py, ...hermes];

if (args.includes("--check")) {
  const bad = everything.filter((p) => !allowed(p.license));
  for (const p of bad) console.error(`licence not allowed or unknown: ${p.kind} ${p.name}@${p.version} (${p.license})`);
  const gpl = programs.filter((p) => !allowed(p.license));
  console.log(`licences: ${everything.length} packages checked${payload ? `, ${programs.length} bundled programs (${gpl.map((p) => `${p.name}: ${p.license}`).join(", ") || "none GPL"}, shipped as separate programs with source offered)` : " (npm only; pass --payload for Python)"}`);
  process.exit(bad.length ? 1 : 0);
}

// A CycloneDX 1.5 software bill of materials: every package and program above, with versions and licences.
const sbomOut = opt("--sbom");
if (sbomOut) {
  const purl = (p) =>
    p.kind === "npm" ? `pkg:npm/${p.name.startsWith("@") ? "%40" + p.name.slice(1) : p.name}@${p.version}` : p.kind === "python" ? `pkg:pypi/${p.name.toLowerCase()}${p.version ? "@" + p.version : ""}` : `pkg:generic/${p.name}@${p.version}`;
  const license = (expr) => (allowed(expr) || /^[A-Za-z0-9.+-]+$/.test(expr) ? [{ expression: expr }] : [{ license: { name: expr } }]);
  const appVersion = JSON.parse(readFileSync(path.join(repo, "apps", "desktop", "package.json"), "utf8")).version;
  const bom = {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      component: { type: "application", name: "Chief Command Center", version: appVersion, licenses: [{ expression: "MIT" }] },
      tools: { components: [{ type: "application", name: "scripts/licenses.mjs" }] },
    },
    components: [...programs, ...everything].map((p) => ({
      type: p.kind === "program" ? "application" : "library",
      name: p.name,
      ...(p.version ? { version: p.version } : {}),
      purl: purl(p),
      licenses: license(p.license),
    })),
  };
  mkdirSync(path.dirname(path.resolve(sbomOut)), { recursive: true });
  writeFileSync(sbomOut, JSON.stringify(bom, null, 2) + "\n");
  console.log(`sbom: ${bom.components.length} components → ${sbomOut}`);
}

const out = opt("--notices");
if (out) {
  const lines = [
    "# Third-party notices",
    "",
    "Chief Command Center includes the software below. Each keeps its own licence; the full texts follow.",
    "",
    ...(programs.length
      ? [
          "## Bundled programs",
          "",
          "These run as separate programs. For the GPL ones, the corresponding source is available from the links (and from the maintainers on request, for three years from each release).",
          "",
          "| Program | Version | Licence | Source |",
          "| --- | --- | --- | --- |",
          ...programs.map((p) => `| ${p.name} | ${p.version} | ${p.license} | ${p.source} |`),
          "",
        ]
      : []),
    "## Packages",
    "",
    "| Package | Version | Kind | Licence |",
    "| --- | --- | --- | --- |",
    ...everything.map((p) => `| ${p.name} | ${p.version} | ${p.kind} | ${p.license} |`),
    "",
    "## Licence texts",
    "",
  ];
  const byText = new Map();
  for (const p of [...programs, ...everything]) {
    const text = (p.text || "").trim();
    if (!text) continue;
    const list = byText.get(text) || [];
    list.push(`${p.name}${p.version ? ` ${p.version}` : ""}`);
    byText.set(text, list);
  }
  for (const [text, names] of byText) lines.push(`### ${names.join(", ")}`, "", "```", text, "```", "");
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, lines.join("\n"));
  console.log(`notices: ${everything.length} packages, ${programs.length} programs, ${byText.size} licence texts → ${out}`);
}
