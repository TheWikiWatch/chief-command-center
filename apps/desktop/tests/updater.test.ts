import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { compareVersions, Updater, type UpdateState, type UpdaterDeps } from "../src/updater";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const other = generateKeyPairSync("ed25519");
const root = mkdtempSync(path.join(tmpdir(), "chief-updater-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let feed: string;
let updates: string;
const pkg = Buffer.alloc(3 * 1024 * 1024 + 11, 7);

function publish(version: string, opts: { body?: Buffer; key?: typeof privateKey; tamper?: boolean; bytes?: number } = {}) {
  const body = opts.body ?? pkg;
  const file = `ChiefCommandCenter-${version}.msix`;
  writeFileSync(path.join(feed, file), body);
  const manifest = {
    format: "chief-release",
    format_version: 1,
    version,
    published: "2026-10-01T00:00:00Z",
    notes: "Fixes.",
    package: { file, bytes: opts.bytes ?? pkg.length, sha256: createHash("sha256").update(pkg).digest("hex") },
    hermes: { base_version: "2026.9.24", commit: "abc" },
    data: { schema: 1, min_reader: version },
  };
  let bytes = Buffer.from(JSON.stringify(manifest, null, 2));
  const sig = sign(null, bytes, opts.key ?? privateKey).toString("base64");
  if (opts.tamper) bytes = Buffer.from(bytes.toString().replace("Fixes.", "Fixes!"));
  writeFileSync(path.join(feed, "release.json"), bytes);
  writeFileSync(path.join(feed, "release.json.sig"), sig);
  return file;
}

function make(over: Partial<UpdaterDeps> = {}) {
  const log: string[] = [];
  const states: UpdateState[] = [];
  const updater = new Updater({
    feed: () => feed,
    currentVersion: "1.0.0",
    publicKey: PUB,
    updatesDir: updates,
    skipped: () => [],
    freeBytes: async () => 10e9,
    activeWork: async () => ({ busy: false, reasons: [] }),
    backup: async () => (log.push("backup"), { ok: true }),
    stopChief: async () => void log.push("stop"),
    install: async (file) => (log.push(`install ${path.basename(file)}`), { ok: true }),
    onState: (s) => states.push(s),
    ...over,
  });
  return { updater, log, states };
}

beforeEach(() => {
  feed = mkdtempSync(path.join(root, "feed-"));
  updates = path.join(mkdtempSync(path.join(root, "data-")), "updates");
});

describe("Updater", () => {
  it("offers a newer signed release, downloads and verifies it, and installs only after a backup and a stop", async () => {
    publish("1.1.0");
    const { updater, log } = make();
    const checked = await updater.check();
    expect(checked).toMatchObject({ status: "available", release: { version: "1.1.0", notes: "Fixes." } });
    const ready = await updater.download();
    expect(ready.status).toBe("ready");
    expect(readFileSync(path.join(updates, "ChiefCommandCenter-1.1.0.msix")).equals(pkg)).toBe(true);
    await updater.install();
    expect(log).toEqual(["backup", "stop", "install ChiefCommandCenter-1.1.0.msix"]);
  });

  it("installs once when Install is pressed again while the first install is still checking", async () => {
    publish("1.1.0");
    let release: () => void = () => undefined;
    const slowCheck = new Promise<void>((r) => (release = r));
    const { updater, log } = make({ activeWork: async () => (await slowCheck, { busy: false, reasons: [] }) });
    await updater.check();
    await updater.download();
    const first = updater.install();
    const second = updater.install(); // a double click, or the same card in Settings
    release();
    await Promise.all([first, second]);
    expect(log.filter((l) => l.startsWith("install"))).toEqual(["install ChiefCommandCenter-1.1.0.msix"]);
    expect(log.filter((l) => l === "backup")).toHaveLength(1);
  });

  it("says up to date only after a successful check, and honours Skip this version", async () => {
    publish("1.0.0");
    expect((await make().updater.check()).status).toBe("up-to-date");
    publish("1.1.0");
    expect((await make({ skipped: () => ["1.1.0"] }).updater.check()).status).toBe("up-to-date");
  });

  it("offline: the check fails with the reason, never 'up to date'", async () => {
    feed = path.join(root, "unreachable-share");
    const state = await make().updater.check();
    expect(state).toEqual({ status: "error", error: expect.stringMatching(/isn't reachable/) });
  });

  it("a bad signature or a tampered manifest is refused before anything is downloaded", async () => {
    publish("1.1.0", { key: other.privateKey });
    expect(await make().updater.check()).toEqual({ status: "error", error: expect.stringMatching(/couldn't be verified/) });
    publish("1.1.0", { tamper: true });
    expect((await make().updater.check()).status).toBe("error");
    expect(existsSync(updates)).toBe(false);
  });

  it("a truncated download resumes; a package that doesn't match its checksum is deleted", async () => {
    const file = publish("1.1.0", { body: pkg.subarray(0, 1024 * 1024) });
    const { updater } = make();
    await updater.check();
    expect(await updater.download()).toEqual(expect.objectContaining({ status: "error", error: expect.stringMatching(/incomplete.*resumes/) }));
    expect(readFileSync(path.join(updates, `${file}.part`)).length).toBe(1024 * 1024);
    writeFileSync(path.join(feed, file), pkg); // the rest becomes available
    expect((await updater.download()).status).toBe("ready");

    const bad = Buffer.from(pkg);
    bad[bad.length - 1] ^= 1;
    rmSync(updates, { recursive: true, force: true });
    publish("1.1.0", { body: bad });
    const second = make().updater;
    await second.check();
    expect(await second.download()).toEqual(expect.objectContaining({ status: "error", error: expect.stringMatching(/didn't match its checksum.*deleted/) }));
    expect(existsSync(path.join(updates, file))).toBe(false);
    expect(existsSync(path.join(updates, `${file}.part`))).toBe(false);
  });

  it("a package larger than its description is refused", async () => {
    publish("1.1.0", { body: Buffer.concat([pkg, Buffer.alloc(10)]) });
    const { updater } = make();
    await updater.check();
    expect(await updater.download()).toEqual(expect.objectContaining({ status: "error", error: expect.stringMatching(/larger than/) }));
  });

  it("disk full: says how much space is needed and writes nothing", async () => {
    publish("1.1.0");
    const { updater } = make({ freeBytes: async () => 1_000_000 });
    await updater.check();
    expect(await updater.download()).toEqual(expect.objectContaining({ status: "error", error: expect.stringMatching(/needs about 4 MB/) }));
  });

  it("never interrupts a turn unless the owner says Install now", async () => {
    publish("1.1.0");
    let busy = true;
    const { updater, log } = make({ activeWork: async () => ({ busy, reasons: busy ? ["Chief is writing a reply."] : [] }) });
    await updater.check();
    await updater.download();
    expect(await updater.install()).toEqual(expect.objectContaining({ status: "busy", reasons: ["Chief is writing a reply."] }));
    expect(log).toEqual([]);
    await updater.install(true);
    expect(log).toEqual(["backup", "stop", "install ChiefCommandCenter-1.1.0.msix"]);
    busy = false;
  });

  it("a failed backup stops the install; a failed Windows install keeps the current version", async () => {
    publish("1.1.0");
    const failing = make({ backup: async () => ({ ok: false, error: "disk full" }) });
    await failing.updater.check();
    await failing.updater.download();
    expect(await failing.updater.install()).toEqual(expect.objectContaining({ status: "error", error: expect.stringMatching(/backup before it failed: disk full/) }));
    expect(failing.log).toEqual([]);
    const restarted: string[] = [];
    const refused = make({ install: async () => ({ ok: false, error: "Windows reports files in use." }), startChief: async () => void restarted.push("start") });
    await refused.updater.check();
    await refused.updater.download();
    expect(await refused.updater.install()).toEqual(expect.objectContaining({ status: "error", error: "Windows reports files in use." }));
    // Chief was stopped for the install, so it is started again.
    expect(refused.log).toEqual(["backup", "stop"]);
    expect(restarted).toEqual(["start"]);
    const thrown = make({ install: async () => { throw new Error("powershell missing"); }, startChief: async () => undefined });
    await thrown.updater.check();
    await thrown.updater.download();
    expect(await thrown.updater.install()).toEqual(expect.objectContaining({ status: "error", error: "powershell missing" }));
  });

  it("reports download progress a few times a second, not once per chunk", async () => {
    publish("1.1.0");
    let t = 0;
    const { updater, states } = make({ now: () => (t += 10) });
    await updater.check();
    await updater.download();
    const progress = states.filter((s) => s.status === "downloading");
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.length).toBeLessThan(12); // ~50 chunks of 64 KB, at most one report per 250 ms
    expect(progress.at(-1)).toMatchObject({ done: pkg.length, total: pkg.length });
  });

  it("compares versions numerically", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.9.0", "1.0.0")).toBe(-1);
    mkdirSync(updates, { recursive: true });
  });
});
