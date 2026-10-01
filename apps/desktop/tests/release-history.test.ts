import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { cacheRelease, historyDir, readInstalls, readReleases, recordInstall, syncGithubHistory } from "../src/release-history";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const other = generateKeyPairSync("ed25519").privateKey;

function signed(version: string, notes: string, key = privateKey) {
  const bytes = Buffer.from(
    JSON.stringify(
      {
        format: "chief-release",
        format_version: 1,
        version,
        published: `2026-10-0${version.at(-1)}T12:00:00.000Z`,
        notes,
        package: { file: `ChiefCommandCenter-${version}.msix`, bytes: 10, sha256: "a".repeat(64) },
        hermes: { base_version: "2026.9.24", commit: "c".repeat(40) },
        data: { schema: 1, min_reader: "0.1.0" },
      },
      null,
      2,
    ) + "\n",
  );
  return { bytes, sig: sign(null, bytes, key).toString("base64") };
}

const roots: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "chief-history-"));
  roots.push(dir);
  return dir;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("the release cache", () => {
  it("keeps only releases that verify, newest first, and ignores damaged files", () => {
    const dir = scratch();
    for (const [v, n] of [["0.1.9", "First"], ["0.1.12", "Newest"], ["0.1.10", "Middle"]]) {
      const r = signed(v, n);
      cacheRelease(dir, r.bytes, r.sig, PUB);
    }
    const forged = signed("0.1.13", "Forged", other);
    expect(() => cacheRelease(dir, forged.bytes, forged.sig, PUB)).toThrow(/couldn't be verified/);
    expect(existsSync(path.join(historyDir(dir), "0.1.13.json"))).toBe(false);
    // Tampered on disk after caching: left out on read.
    const tampered = path.join(historyDir(dir), "0.1.10.json");
    writeFileSync(tampered, readFileSync(tampered, "utf8").replace("Middle", "Changed"));
    expect(readReleases(dir, PUB).map((r) => [r.version, r.notes])).toEqual([
      ["0.1.12", "Newest"],
      ["0.1.9", "First"],
    ]);
  });
});

describe("install records", () => {
  it("notes each version's first start, once, with what it replaced", () => {
    const dir = scratch();
    recordInstall(dir, "0.1.11", "", new Date("2026-10-01T10:00:00Z"));
    recordInstall(dir, "0.1.11", "0.1.11", new Date("2026-10-01T11:00:00Z"));
    recordInstall(dir, "0.1.12", "0.1.11", new Date("2026-10-02T09:00:00Z"));
    expect(readInstalls(dir)).toEqual([
      { version: "0.1.11", at: "2026-10-01T10:00:00.000Z", from: "" },
      { version: "0.1.12", at: "2026-10-02T09:00:00.000Z", from: "0.1.11" },
    ]);
    expect(readInstalls(scratch())).toEqual([]);
  });
});

describe("syncing from the private release repository", () => {
  it("fetches and verifies each release not kept yet, never sending the key to the download host", async () => {
    const dir = scratch();
    const files: Record<string, Buffer> = {};
    const releases = ["0.1.12", "0.1.11", "0.1.10"].map((v, i) => {
      const r = signed(v, `Notes ${v}`, v === "0.1.10" ? other : privateKey); // 0.1.10 is forged
      files[`${i * 2}`] = r.bytes;
      files[`${i * 2 + 1}`] = Buffer.from(r.sig);
      return { tag_name: `v${v}`, assets: [{ id: i * 2, name: "release.json" }, { id: i * 2 + 1, name: "release.json.sig" }, { id: 99, name: "pkg.msix" }] };
    });
    const calls: { url: string; auth: string | null }[] = [];
    const impl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url.endsWith("/releases?per_page=100")) return Response.json(releases);
      const asset = /\/releases\/assets\/(\d+)$/.exec(url);
      if (asset) return new Response(null, { status: 302, headers: { location: `https://objects.example/${asset[1]}` } });
      const blob = /^https:\/\/objects\.example\/(\d+)$/.exec(url);
      if (blob && files[blob[1]]) return new Response(files[blob[1]]);
      return new Response("?", { status: 404 });
    }) as typeof fetch;

    expect(await syncGithubHistory("me", "chief-releases", "github_pat_x", dir, PUB, impl)).toBe(2);
    expect(readReleases(dir, PUB).map((r) => r.version)).toEqual(["0.1.12", "0.1.11"]);
    expect(calls.some((c) => c.url.includes("/assets/99"))).toBe(false); // never the package
    expect(calls.filter((c) => c.url.startsWith("https://objects.example")).every((c) => c.auth === null)).toBe(true);

    const before = calls.length;
    expect(await syncGithubHistory("me", "chief-releases", "github_pat_x", dir, PUB, impl)).toBe(0);
    // Kept releases aren't fetched again (only the forged one is retried).
    expect(calls.slice(before).filter((c) => c.url.includes("/assets/")).map((c) => c.url.split("/").pop())).toEqual(["4", "5"]);
  });
});
