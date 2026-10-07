import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { syncGithubHistory } from "../src/release-history";
import { githubSource } from "../src/release-source";
import { Updater, type Release } from "../src/updater";

/**
 * Apps a few releases behind (2026-10-07): a key kept from when the releases repository was private, now expired, made
 * GitHub refuse every check (401, even for a public repository); and fetching the history through the API spent
 * GitHub's 60 calls an hour without a key. Plus installing any published version, newer or older.
 */

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const root = mkdtempSync(path.join(tmpdir(), "chief-behind-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function manifest(version: string, pkg: Buffer) {
  const bytes = Buffer.from(
    JSON.stringify({
      format: "chief-release",
      format_version: 1,
      version,
      published: "2026-10-01T00:00:00Z",
      notes: `Notes for ${version}.`,
      package: { file: `ChiefCommandCenter-${version}.msix`, bytes: pkg.length, sha256: createHash("sha256").update(pkg).digest("hex") },
      hermes: { base_version: "2026.9.24", commit: "abc" },
      data: { schema: 1, min_reader: version },
    }),
  );
  return { bytes, sig: Buffer.from(sign(null, bytes, privateKey).toString("base64")) };
}

/**
 * A public releases repository on a fake GitHub. `validKey` is the only key it accepts (any other is refused with 401,
 * as GitHub does); assets are served both through the API and by their plain download links, and every API call is
 * counted (the 60-an-hour budget).
 */
function fakeGithub(versions: string[], opts: { validKey?: string; privateRepo?: boolean } = {}) {
  const files = new Map<string, Buffer>();
  const releases = versions.map((v, i) => {
    const pkg = Buffer.alloc(4096 + i, i + 1);
    const m = manifest(v, pkg);
    const named: [string, Buffer][] = [
      ["release.json", m.bytes],
      ["release.json.sig", m.sig],
      [`ChiefCommandCenter-${v}.msix`, pkg],
    ];
    return {
      tag_name: `v${v}`,
      assets: named.map(([name, body], j) => {
        const id = i * 10 + j;
        files.set(String(id), body);
        return { id, name, browser_download_url: `https://github.com/me/r/releases/download/v${v}/${name}` };
      }),
    };
  });
  const byName = new Map(releases.flatMap((r) => r.assets.map((a) => [a.browser_download_url, files.get(String(a.id))!] as const)));
  const calls = { api: 0, refused: 0, sentKey: [] as (string | null)[] };
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    if (url.startsWith("https://api.github.com")) {
      calls.api++;
      calls.sentKey.push(auth);
      if (auth && auth !== `Bearer ${opts.validKey}`) return (calls.refused++, new Response("Bad credentials", { status: 401 }));
      if (opts.privateRepo && !auth) return new Response("Not Found", { status: 404 });
      const latest = /\/releases\/latest$/.test(url);
      const tag = /\/releases\/tags\/v([\d.]+)$/.exec(url)?.[1];
      if (latest) return Response.json(releases.at(-1));
      if (tag) return releases.find((r) => r.tag_name === `v${tag}`) ? Response.json(releases.find((r) => r.tag_name === `v${tag}`)) : new Response("Not Found", { status: 404 });
      if (/\/releases\?per_page=/.test(url)) return Response.json([...releases].reverse());
      const asset = /\/releases\/assets\/(\d+)$/.exec(url)?.[1];
      if (asset) return new Response(null, { status: 302, headers: { location: `https://objects.example/${asset}` } });
      return new Response("?", { status: 404 });
    }
    if (url.startsWith("https://github.com/")) {
      if (!byName.has(url)) return new Response("?", { status: 404 });
      return new Response(null, { status: 302, headers: { location: `https://objects.example/by-url?${encodeURIComponent(url)}` } });
    }
    const blob = /^https:\/\/objects\.example\/(\d+)$/.exec(url)?.[1];
    const body = blob ? files.get(blob) : byName.get(decodeURIComponent(url.split("?")[1] || ""));
    if (!body) return new Response("?", { status: 404 });
    const range = new Headers(init?.headers).get("range");
    return range ? new Response(body.subarray(Number(/bytes=(\d+)-/.exec(range)![1])), { status: 206 }) : new Response(body, { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("a key kept from the private days", () => {
  it("is retried without, so an expired key no longer blocks updates, and is never sent again that session", async () => {
    const gh = fakeGithub(["0.1.29", "0.1.30"]);
    const src = githubSource("me", "r", "github_pat_expired", gh.impl);
    await src.refresh();
    expect(JSON.parse((await src.read("release.json")).toString()).version).toBe("0.1.30");
    expect(src.keyRefused?.()).toBe(true);
    expect(gh.calls.refused).toBe(1);
    expect(gh.calls.sentKey.slice(1).every((k) => k === null)).toBe(true);
  });

  it("a private repository still says the key was refused (without it nothing answers)", async () => {
    const gh = fakeGithub(["0.1.30"], { privateRepo: true });
    await expect(githubSource("me", "r", "github_pat_expired", gh.impl).refresh()).rejects.toThrow(/key was refused.*remove it if the release repository is public/);
  });

  it("a valid key keeps being used (a private repository, or the higher rate limit)", async () => {
    const gh = fakeGithub(["0.1.30"], { validKey: "github_pat_good" });
    const src = githubSource("me", "r", "github_pat_good", gh.impl);
    await src.refresh();
    await src.read("release.json");
    expect(src.keyRefused?.()).toBe(false);
    expect(gh.calls.sentKey.every((k) => k === "Bearer github_pat_good")).toBe(true);
  });
});

describe("GitHub's 60 calls an hour", () => {
  it("without a key, a check is one API call: files come by their download links", async () => {
    const gh = fakeGithub(["0.1.29", "0.1.30"]);
    const src = githubSource("me", "r", "", gh.impl);
    await src.refresh();
    await src.read("release.json");
    await src.read("release.json.sig");
    expect(gh.calls.api).toBe(1);
  });

  it("an app 20 versions behind fetches the whole history for one API call", async () => {
    const versions = Array.from({ length: 20 }, (_, i) => `0.1.${i + 10}`);
    const gh = fakeGithub(versions);
    const added = await syncGithubHistory("me", "r", "", path.join(root, "history-app"), PUB, gh.impl);
    expect(added).toBe(20);
    expect(gh.calls.api).toBe(1);
  });
});

describe("installing any published version", () => {
  function updaterFor(versions: string[], current: string) {
    const gh = fakeGithub(versions);
    const dir = mkdtempSync(path.join(root, "app-"));
    const log: string[] = [];
    // The kept history (the sync's job): each version's description, for the package the fake serves.
    const history = () => versions.map((v, i) => JSON.parse(manifest(v, Buffer.alloc(4096 + i, i + 1)).bytes.toString()) as Release);
    const updater = new Updater({
      source: () => githubSource("me", "r", "", gh.impl),
      currentVersion: current,
      publicKey: PUB,
      updatesDir: path.join(dir, "updates"),
      skipped: () => [],
      freeBytes: async () => 10e9,
      activeWork: async () => ({ busy: false, reasons: [] }),
      backup: async () => (log.push("backup"), { ok: true }),
      stopChief: async () => void log.push("stop"),
      handOff: async (file) => (log.push(`hand off ${path.basename(file)}`), { ok: true, via: "helper" }),
      history,
    });
    return { updater, log, gh };
  }

  it("goes back to an older version: downloads that release, checks it, prepares it and marks it older", async () => {
    const { updater, log } = updaterFor(["0.1.27", "0.1.28", "0.1.29", "0.1.30"], "0.1.30");
    const ready = await updater.installVersion("0.1.27");
    expect(ready).toMatchObject({ status: "ready", release: { version: "0.1.27" }, older: true });
    await updater.restart();
    expect(log.at(-1)).toBe("hand off ChiefCommandCenter-0.1.27.msix");
  });

  it("a chosen version survives the daily check, which would otherwise offer the latest", async () => {
    const { updater } = updaterFor(["0.1.27", "0.1.30", "0.1.31"], "0.1.30");
    await updater.installVersion("0.1.27");
    expect(await updater.check()).toMatchObject({ status: "ready", release: { version: "0.1.27" } });
  });

  it("an app far behind can jump straight to the newest, or to any version in between", async () => {
    const { updater } = updaterFor(["0.1.12", "0.1.20", "0.1.25", "0.1.31"], "0.1.12");
    expect((await updater.check()) as { release?: Release }).toMatchObject({ status: "available", release: { version: "0.1.31" } });
    expect(await updater.installVersion("0.1.25")).toMatchObject({ status: "ready", release: { version: "0.1.25" } });
  });

  it("refuses the running version and one this PC doesn't know yet", async () => {
    const { updater } = updaterFor(["0.1.29", "0.1.30"], "0.1.30");
    expect(await updater.installVersion("0.1.30")).toMatchObject({ status: "error", error: expect.stringMatching(/is the one running/) });
    expect(await updater.installVersion("0.1.5")).toMatchObject({ status: "error", error: expect.stringMatching(/isn't known on this PC yet/) });
  });
});
