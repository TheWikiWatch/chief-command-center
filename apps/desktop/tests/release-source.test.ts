import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { githubSource, parseGithub } from "../src/release-source";
import { Updater } from "../src/updater";

describe("parseGithub", () => {
  it("reads owner/repo from the forms the Settings field accepts, and nothing else", () => {
    expect(parseGithub("github:me/chief-releases")).toEqual({ owner: "me", repo: "chief-releases" });
    expect(parseGithub("https://github.com/me/chief-releases.git")).toEqual({ owner: "me", repo: "chief-releases" });
    expect(parseGithub(" https://github.com/me/chief-releases/ ")).toEqual({ owner: "me", repo: "chief-releases" });
    expect(parseGithub("E:\\ChiefReleases")).toBeNull();
    expect(parseGithub("https://example.com/me/repo")).toBeNull();
  });
});

/** A tiny fake GitHub: the latest release's assets, served through a redirect to a download host. */
function fakeGithub(files: Record<string, Buffer>, opts: { status?: number } = {}) {
  const calls: { url: string; auth: string | null; range: string | null }[] = [];
  const ids = Object.keys(files);
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("authorization"), range: headers.get("range") });
    if (opts.status) return new Response("no", { status: opts.status });
    if (url.endsWith("/releases/latest")) return Response.json({ assets: ids.map((name, id) => ({ id, name })) });
    const asset = /\/releases\/assets\/(\d+)$/.exec(url);
    if (asset) return new Response(null, { status: 302, headers: { location: `https://objects.example/${asset[1]}` } });
    const blob = /^https:\/\/objects\.example\/(\d+)$/.exec(url);
    if (blob) {
      const body = files[ids[Number(blob[1])]];
      const range = headers.get("range");
      if (range) {
        const start = Number(/bytes=(\d+)-/.exec(range)![1]);
        return new Response(body.subarray(start), { status: 206 });
      }
      return new Response(body, { status: 200 });
    }
    return new Response("?", { status: 404 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("githubSource", () => {
  it("reads the latest release's files with the key, and never sends the key to the download host", async () => {
    const gh = fakeGithub({ "release.json": Buffer.from("{}"), "pkg.msix": Buffer.from("0123456789") });
    const src = githubSource("me", "chief-releases", "github_pat_x", gh.impl);
    await src.refresh();
    expect((await src.read("release.json")).toString()).toBe("{}");
    const tail = await src.open("pkg.msix", 4);
    const chunks: Buffer[] = [];
    for await (const c of tail) chunks.push(Buffer.from(c as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe("456789");
    expect(gh.calls.filter((c) => c.url.startsWith("https://api.github.com")).every((c) => c.auth === "Bearer github_pat_x")).toBe(true);
    expect(gh.calls.filter((c) => c.url.startsWith("https://objects.example")).every((c) => c.auth === null)).toBe(true);
    expect(gh.calls.at(-1)?.range).toBe("bytes=4-");
  });

  it("says plainly when the key is refused or the repository can't be read", async () => {
    await expect(githubSource("me", "r", "old", fakeGithub({}, { status: 401 }).impl).refresh()).rejects.toThrow(/expired or been revoked/);
    await expect(githubSource("me", "r", "k", fakeGithub({}, { status: 404 }).impl).refresh()).rejects.toThrow(/wasn't found, or the key can't read it/);
    const empty = githubSource("me", "r", "k", fakeGithub({}).impl);
    await empty.refresh();
    await expect(empty.read("release.json")).rejects.toThrow(/has no release.json/);
  });
});

describe("Updater with a GitHub source", () => {
  const root = mkdtempSync(path.join(tmpdir(), "chief-gh-updater-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("offers, downloads and verifies a release from the private repository", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pkg = Buffer.alloc(1024 * 1024 + 3, 9);
    const manifest = Buffer.from(
      JSON.stringify({
        format: "chief-release", format_version: 1, version: "2.0.0", published: "2026-10-01T00:00:00Z", notes: "New.",
        package: { file: "Chief-2.0.0.appx", bytes: pkg.length, sha256: createHash("sha256").update(pkg).digest("hex") },
        hermes: { base_version: "2026.9.24", commit: "abc" }, data: { schema: 1, min_reader: "2.0.0" },
      }),
    );
    const gh = fakeGithub({ "release.json": manifest, "release.json.sig": Buffer.from(sign(null, manifest, privateKey).toString("base64")), "Chief-2.0.0.appx": pkg });
    const updater = new Updater({
      source: () => githubSource("me", "chief-releases", "k", gh.impl),
      currentVersion: "1.0.0",
      publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      updatesDir: path.join(root, "updates"),
      skipped: () => [],
      freeBytes: async () => 10e9,
      activeWork: async () => ({ busy: false, reasons: [] }),
      backup: async () => ({ ok: true }),
      stopChief: async () => undefined,
      install: async () => ({ ok: true }),
    });
    expect((await updater.check()).status).toBe("available");
    const ready = await updater.download();
    expect(ready.status === "error" ? ready.error : ready.status).toBe("ready");
    if (ready.status === "ready") expect(readFileSync(ready.file).equals(pkg)).toBe(true);
  });
});

it("a GitHub source without a key says where to put one, and asks GitHub nothing", async () => {
  const gh = fakeGithub({});
  await expect(githubSource("me", "r", "", gh.impl).refresh()).rejects.toThrow(/needs an update key/);
  expect(gh.calls).toHaveLength(0);
});
