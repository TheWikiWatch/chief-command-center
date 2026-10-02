import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { githubApi, type GithubRelease } from "./release-source";
import { compareVersions, verifyRelease, type Release, type ReleaseKeys } from "./updater";

/**
 * Update history (Settings → Backup & updates → History, and "What's new" after an update).
 *
 * - `<appDir>/release-history/<version>.json` + `.json.sig`: every release this install has seen, exactly as
 *   signed. Each one is verified against the pinned key before it is written, and again when read, so the list
 *   shows only genuine releases. Releases never change, so a version is fetched once and then works offline.
 * - `<appDir>/update-history.json`: when each version first started on this PC (and what it replaced).
 *
 * The dashboard server reads both (apps/web/lib/server/update-history.ts), so the phone sees the same list.
 */
export type InstallRecord = { version: string; at: string; from: string };

export const historyDir = (appDir: string) => path.join(appDir, "release-history");
export const installsFile = (appDir: string) => path.join(appDir, "update-history.json");

/** Verify a release's signed description and keep it. Throws when it doesn't verify. */
export function cacheRelease(appDir: string, bytes: Buffer, signature: string, publicKey: ReleaseKeys): Release {
  const release = verifyRelease(bytes, signature, publicKey);
  const dir = historyDir(appDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${release.version}.json`);
  if (!existsSync(file) || !existsSync(`${file}.sig`)) {
    writeFileSync(`${file}.sig.tmp`, signature.trim());
    writeFileSync(`${file}.tmp`, bytes);
    renameSync(`${file}.tmp`, file);
    renameSync(`${file}.sig.tmp`, `${file}.sig`);
  }
  return release;
}

/** The cached releases that still verify, newest first. */
export function readReleases(appDir: string, publicKey: ReleaseKeys): Release[] {
  const dir = historyDir(appDir);
  if (!existsSync(dir)) return [];
  const out: Release[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^\d+\.\d+\.\d+\.json$/.test(name)) continue;
    try {
      const file = path.join(dir, name);
      const release = verifyRelease(readFileSync(file), readFileSync(`${file}.sig`, "utf8"), publicKey);
      if (`${release.version}.json` === name) out.push(release);
    } catch {
      /* a damaged or unsigned file is left out */
    }
  }
  return out.sort((a, b) => compareVersions(b.version, a.version));
}

export function readInstalls(appDir: string): InstallRecord[] {
  try {
    const raw = JSON.parse(readFileSync(installsFile(appDir), "utf8")) as { installs?: unknown };
    return Array.isArray(raw.installs)
      ? raw.installs.filter((r): r is InstallRecord => !!r && typeof r === "object" && typeof (r as InstallRecord).version === "string" && typeof (r as InstallRecord).at === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Note the first start of `version` (what it replaced, "" for a first install). The same version twice in a
 * row is one record; going back to an older version is recorded too.
 */
export function recordInstall(appDir: string, version: string, previous: string, now = new Date()): InstallRecord[] {
  const installs = readInstalls(appDir);
  if (installs.at(-1)?.version === version) return installs;
  if (previous === version && installs.length) return installs;
  const next = [...installs, { version, at: now.toISOString(), from: previous && previous !== version ? previous : "" }].slice(-200);
  mkdirSync(appDir, { recursive: true });
  const file = installsFile(appDir);
  writeFileSync(`${file}.tmp`, JSON.stringify({ installs: next }, null, 2));
  renameSync(`${file}.tmp`, file);
  return next;
}

/**
 * Fetch, verify and keep every published release this install hasn't seen yet (one listing call, then two small
 * files per new release). Returns how many were added.
 */
export async function syncGithubHistory(owner: string, repo: string, key: string, appDir: string, publicKey: ReleaseKeys, fetchImpl: typeof fetch = fetch): Promise<number> {
  const gh = githubApi(owner, repo, key, fetchImpl);
  const releases = await gh.json<GithubRelease[]>("/releases?per_page=100");
  const dir = historyDir(appDir);
  let added = 0;
  for (const r of releases) {
    const version = /^v?(\d+\.\d+\.\d+)$/.exec(r.tag_name || "")?.[1];
    if (!version || existsSync(path.join(dir, `${version}.json.sig`))) continue;
    const ids = new Map((r.assets || []).map((a) => [a.name, a.id]));
    const json = ids.get("release.json");
    const sig = ids.get("release.json.sig");
    if (json === undefined || sig === undefined) continue;
    try {
      const bytes = Buffer.from(await (await gh.asset(json)).arrayBuffer());
      const signature = Buffer.from(await (await gh.asset(sig)).arrayBuffer()).toString("utf8");
      const release = cacheRelease(appDir, bytes, signature, publicKey);
      if (release.version === version) added++;
    } catch {
      /* one bad or unreachable release doesn't stop the rest */
    }
  }
  return added;
}
