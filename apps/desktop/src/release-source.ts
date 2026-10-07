import { createReadStream, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * Where releases come from (PLAN §8a). Two kinds:
 * - a folder (a local or network release folder);
 * - a GitHub repository holding only releases: a public one read without a key, or a private one read with a
 *   per-person read-only key (a fine-grained token with Contents: read on that one repository).
 * Either way the updater still verifies release.json against the pinned Ed25519 key and the package against
 * its signed digest, so a leaked key can't deliver a forged update.
 */
export interface ReleaseSource {
  /** For messages: the folder, or owner/repo. */
  label: string;
  /** Called once per check, before reading (GitHub: finds the latest release's files). */
  refresh(): Promise<void>;
  read(name: string): Promise<Buffer>;
  /** The file from byte `start` on (a resumed download). */
  open(name: string, start: number): Promise<Readable>;
}

export class SourceError extends Error {}

export function folderSource(dir: string): ReleaseSource {
  return {
    label: dir,
    refresh: async () => {
      try {
        await fs.access(dir);
      } catch {
        throw new SourceError(`the release folder (${dir}) isn't reachable.`);
      }
    },
    read: async (name) => {
      try {
        return await fs.readFile(path.join(dir, name));
      } catch {
        throw new SourceError(`the release folder (${dir}) isn't reachable.`);
      }
    },
    open: async (name, start) => createReadStream(path.join(dir, name), { start }),
  };
}

/**
 * The update source a release build carries (`chiefUpdateFeed` in its package.json, set from the maintainer's
 * release.local.json), so a tester's install already knows where updates come from. "" when there is none.
 */
export function builtInFeed(appPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(appPath, "package.json"), "utf8")) as { chiefUpdateFeed?: unknown };
    return typeof pkg.chiefUpdateFeed === "string" ? pkg.chiefUpdateFeed.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Where "Report a problem" e-mails go (`chiefReportEmail`, set at release time from the maintainer's
 * release.local.json; never in the repository). "" when a build has none, and the button stays hidden.
 */
export function builtInReportEmail(appPath: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(appPath, "package.json"), "utf8")) as { chiefReportEmail?: unknown };
    const email = typeof pkg.chiefReportEmail === "string" ? pkg.chiefReportEmail.trim() : "";
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
  } catch {
    return "";
  }
}

/** The source the owner saved in Settings wins; otherwise the one built in. */
export function effectiveFeed(saved: string, builtIn: string): string {
  return saved.trim() || builtIn.trim();
}

/** `github:owner/repo` or `https://github.com/owner/repo`, else null (a folder). */
export function parseGithub(feed: string): { owner: string; repo: string } | null {
  const text = feed.trim();
  const m = /^(?:github:|https:\/\/github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(text);
  return m ? { owner: m[1], repo: m[2] } : null;
}

type Fetch = typeof fetch;

/**
 * A GitHub release repository: the API calls both the updater and the history use. A public repository needs no
 * key (GitHub allows 60 unauthenticated calls an hour per network; a check makes one or two); a saved key is
 * sent when there is one, so a private repository keeps working.
 */
export function githubApi(owner: string, repo: string, key: string, fetchImpl: Fetch = fetch) {
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const headers: Record<string, string> = { "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ChiefCommandCenter", ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  const refused = (status: number) =>
    status === 401
      ? new SourceError("the update key was refused: it may have expired or been revoked. Ask for a new key, or clear it if the release repository is public.")
      : status === 403 || status === 429
        ? new SourceError(
            key
              ? "the update key can't read the release repository (or GitHub's rate limit was reached). Try again later, or ask for a new key."
              : "GitHub's limit for checks without a key was reached on this network. Try again in an hour.",
          )
        : status === 404
          ? new SourceError(
              key
                ? `the release repository (${owner}/${repo}) wasn't found, or the key can't read it, or it has no release yet.`
                : `the release repository (${owner}/${repo}) wasn't found or is private (then it needs an update key: Settings, then Backup & updates), or it has no release yet.`,
            )
          : new SourceError(`GitHub answered ${status}.`);
  const json = async <T>(pathPart: string): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(`${api}${pathPart}`, { headers: { ...headers, Accept: "application/vnd.github+json" } });
    } catch {
      throw new SourceError("GitHub isn't reachable (offline?).");
    }
    if (!res.ok) throw refused(res.status);
    return (await res.json()) as T;
  };
  /** An asset's bytes live behind a short-lived redirect; the key is never sent on to that host. */
  const asset = async (id: number, range?: string): Promise<Response> => {
    let res: Response;
    try {
      res = await fetchImpl(`${api}/releases/assets/${id}`, { headers: { ...headers, Accept: "application/octet-stream" }, redirect: "manual" });
    } catch {
      throw new SourceError("GitHub isn't reachable (offline?).");
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new SourceError("GitHub sent an empty redirect.");
      try {
        res = await fetchImpl(location, { headers: range ? { Range: range } : {} });
      } catch {
        throw new SourceError("the download host isn't reachable (offline?).");
      }
    }
    if (!res.ok) throw refused(res.status);
    return res;
  };
  return { label: `${owner}/${repo}`, json, asset };
}

export type GithubRelease = { tag_name: string; draft?: boolean; prerelease?: boolean; assets?: { id: number; name: string }[] };

function tagVersion(tag: string): number[] {
  return (tag.match(/\d+/g) || []).slice(0, 3).map(Number);
}

/**
 * The release an early-updates install takes: the highest version among the published ones that carry a release
 * description, prereleases included (a prerelease is the owner's soak; `release:promote` makes it the latest for
 * everyone). Drafts never count.
 */
export function newestRelease(releases: GithubRelease[]): GithubRelease | null {
  const usable = releases.filter((r) => !r.draft && (r.assets || []).some((a) => a.name === "release.json"));
  usable.sort((a, b) => {
    const va = tagVersion(a.tag_name);
    const vb = tagVersion(b.tag_name);
    for (let i = 0; i < 3; i++) if ((vb[i] || 0) !== (va[i] || 0)) return (vb[i] || 0) - (va[i] || 0);
    return 0;
  });
  return usable[0] ?? null;
}

/**
 * `early`: also take prereleases (Settings → Updates → Early updates). Without it the source reads `/releases/latest`,
 * which GitHub never points at a prerelease, so testers don't see a release until it's promoted.
 */
export function githubSource(owner: string, repo: string, key: string, fetchImpl: Fetch = fetch, options: { early?: () => boolean } = {}): ReleaseSource {
  const gh = githubApi(owner, repo, key, fetchImpl);
  let assets = new Map<string, number>();

  async function assetResponse(name: string, range?: string): Promise<Response> {
    const id = assets.get(name);
    if (id === undefined) throw new SourceError(`the latest release has no ${name}.`);
    return gh.asset(id, range);
  }

  return {
    label: gh.label,
    refresh: async () => {
      const body = options.early?.() ? newestRelease(await gh.json<GithubRelease[]>("/releases?per_page=20")) : await gh.json<GithubRelease>("/releases/latest");
      if (!body) throw new SourceError(`the release repository (${owner}/${repo}) has no release yet.`);
      assets = new Map((body.assets || []).map((a) => [a.name, a.id]));
    },
    read: async (name) => Buffer.from(await (await assetResponse(name)).arrayBuffer()),
    open: async (name, start) => {
      const res = await assetResponse(name, start > 0 ? `bytes=${start}-` : undefined);
      if (start > 0 && res.status !== 206) throw new SourceError("the download host can't resume; delete the partial download and try again.");
      if (!res.body) throw new SourceError("the download came back empty.");
      return Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
    },
  };
}
