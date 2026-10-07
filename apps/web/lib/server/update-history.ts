import { promises as fs } from "node:fs";
import path from "node:path";
import { compareVersions } from "@/lib/versions";

/**
 * The update history the desktop app keeps (apps/desktop/src/release-history.ts): each release it has seen,
 * kept exactly as signed and verified before it was written, and when each version first started here. Read
 * from the app's data folder (CHIEF_APP_DATA), so the phone shows the same list as the PC. Empty in a
 * development build, which has no app data folder.
 */
export type HistoryRelease = {
  version: string;
  published: string;
  notes: string;
  hermes: string;
  /** "New in Hermes": two or three short lines a release that moved Hermes carries (release-tool --hermes-highlights). */
  highlights?: string[];
};
export type HistoryInstall = { version: string; at: string; from: string };
export type UpdateHistory = { available: boolean; current: string; releases: HistoryRelease[]; installs: HistoryInstall[] };

const VERSION = /^\d+\.\d+\.\d+$/;
const stripBom = (text: string) => text.replace(/^\uFEFF/, "");

const compare = compareVersions;

export async function readUpdateHistory(appDir = process.env.CHIEF_APP_DATA || "", current = process.env.CHIEF_APP_VERSION || ""): Promise<UpdateHistory> {
  if (!appDir) return { available: false, current, releases: [], installs: [] };
  const dir = path.join(appDir, "release-history");
  const releases: HistoryRelease[] = [];
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    names = [];
  }
  for (const name of names) {
    const version = name.replace(/\.json$/, "");
    if (!name.endsWith(".json") || !VERSION.test(version) || !names.includes(`${name}.sig`)) continue;
    try {
      const r = JSON.parse(stripBom(await fs.readFile(path.join(dir, name), "utf8"))) as {
        format?: string;
        version?: string;
        published?: string;
        notes?: string;
        hermes?: { base_version?: string; highlights?: unknown };
      };
      if (r.format !== "chief-release" || r.version !== version) continue;
      const highlights = Array.isArray(r.hermes?.highlights)
        ? r.hermes.highlights.filter((h): h is string => typeof h === "string" && !!h.trim()).map((h) => h.trim().slice(0, 120)).slice(0, 3)
        : [];
      releases.push({
        version,
        published: String(r.published || ""),
        notes: String(r.notes || "").trim(),
        hermes: String(r.hermes?.base_version || ""),
        ...(highlights.length ? { highlights } : {}),
      });
    } catch {
      /* a damaged file is left out */
    }
  }
  releases.sort((a, b) => compare(b.version, a.version));
  let installs: HistoryInstall[] = [];
  try {
    const raw = JSON.parse(stripBom(await fs.readFile(path.join(appDir, "update-history.json"), "utf8"))) as { installs?: unknown[] };
    installs = (raw.installs || [])
      .filter((r): r is HistoryInstall => !!r && typeof r === "object" && VERSION.test(String((r as HistoryInstall).version)) && !Number.isNaN(Date.parse(String((r as HistoryInstall).at))))
      .map((r) => ({ version: r.version, at: r.at, from: VERSION.test(String(r.from)) ? r.from : "" }));
  } catch {
    installs = [];
  }
  return { available: true, current, releases, installs };
}
