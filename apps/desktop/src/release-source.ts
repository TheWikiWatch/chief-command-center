import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * Where releases come from (PLAN §8a). Two kinds:
 * - a folder (a local or network release folder);
 * - a private GitHub repository holding only releases, read with a per-person read-only key (a fine-grained
 *   token with Contents: read on that one repository). Testers never see the source code.
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

/** `github:owner/repo` or `https://github.com/owner/repo`, else null (a folder). */
export function parseGithub(feed: string): { owner: string; repo: string } | null {
  const text = feed.trim();
  const m = /^(?:github:|https:\/\/github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(text);
  return m ? { owner: m[1], repo: m[2] } : null;
}

type Fetch = typeof fetch;

export function githubSource(owner: string, repo: string, key: string, fetchImpl: Fetch = fetch): ReleaseSource {
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const headers = { Authorization: `Bearer ${key}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ChiefCommandCenter" };
  let assets = new Map<string, number>();

  const refused = (status: number) =>
    status === 401
      ? new SourceError("the update key was refused: it may have expired or been revoked. Ask for a new key.")
      : status === 403
        ? new SourceError("the update key can't read the release repository (or GitHub's rate limit was reached). Try again later, or ask for a new key.")
        : status === 404
          ? new SourceError(`the release repository (${owner}/${repo}) wasn't found, or the key can't read it, or it has no release yet.`)
          : new SourceError(`GitHub answered ${status}.`);

  /** An asset's bytes live behind a short-lived redirect; the key is never sent on to that host. */
  async function assetResponse(name: string, range?: string): Promise<Response> {
    const id = assets.get(name);
    if (id === undefined) throw new SourceError(`the latest release has no ${name}.`);
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
  }

  return {
    label: `${owner}/${repo}`,
    refresh: async () => {
      if (!key) throw new SourceError("this release repository needs an update key: paste the one you were given in Settings, then Backup & updates.");
      let res: Response;
      try {
        res = await fetchImpl(`${api}/releases/latest`, { headers: { ...headers, Accept: "application/vnd.github+json" } });
      } catch {
        throw new SourceError("GitHub isn't reachable (offline?).");
      }
      if (!res.ok) throw refused(res.status);
      const body = (await res.json()) as { assets?: { id: number; name: string }[] };
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
