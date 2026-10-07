import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { packageName, Updater, verifyRelease, type Release, type UpdateState } from "../src/updater";

/* Release keys that rotate, the packages kept for "Go back", throttled progress, and going back. */

const keyA = generateKeyPairSync("ed25519");
const keyB = generateKeyPairSync("ed25519");
const pub = (k: typeof keyA) => k.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const root = mkdtempSync(path.join(tmpdir(), "chief-rotation-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function manifest(version: string, extra: Record<string, unknown> = {}, body = Buffer.alloc(1024, 3)) {
  return {
    format: "chief-release",
    format_version: 1,
    version,
    published: "2026-10-01T00:00:00Z",
    notes: "",
    package: { file: packageName(version), bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") },
    hermes: { base_version: "2026.9.24", commit: "abc" },
    data: { schema: 1, min_reader: version },
    ...extra,
  };
}

function signed(m: object, key: typeof keyA) {
  const bytes = Buffer.from(JSON.stringify(m));
  return { bytes, sig: sign(null, bytes, key.privateKey).toString("base64") };
}

describe("release keys", () => {
  const keys = [
    { id: "old", publicKey: pub(keyA), expires: "2026-12-31" },
    { id: "new", publicKey: pub(keyB) },
  ];

  it("the named key must sign it; a manifest without a name may use any pinned key", () => {
    const viaNew = signed(manifest("1.1.0", { signing: { key_id: "new" } }), keyB);
    expect(verifyRelease(viaNew.bytes, viaNew.sig, keys).version).toBe("1.1.0");
    const legacy = signed(manifest("1.1.0"), keyA);
    expect(verifyRelease(legacy.bytes, legacy.sig, keys).version).toBe("1.1.0");
    // Claiming one key while signed by the other fails, as does an id that isn't pinned.
    const lying = signed(manifest("1.1.0", { signing: { key_id: "old" } }), keyB);
    expect(() => verifyRelease(lying.bytes, lying.sig, keys)).toThrow("couldn't be verified");
    const unknown = signed(manifest("1.1.0", { signing: { key_id: "nope" } }), keyA);
    expect(() => verifyRelease(unknown.bytes, unknown.sig, keys)).toThrow("couldn't be verified");
  });

  it("an expired key doesn't verify manifests published after its date", () => {
    const late = signed(manifest("1.2.0", { published: "2027-02-01T00:00:00Z", signing: { key_id: "old" } }), keyA);
    expect(() => verifyRelease(late.bytes, late.sig, keys)).toThrow("couldn't be verified");
    const onTime = signed(manifest("1.2.0", { published: "2026-11-01T00:00:00Z", signing: { key_id: "old" } }), keyA);
    expect(verifyRelease(onTime.bytes, onTime.sig, keys).version).toBe("1.2.0");
  });
});

describe("kept packages and going back", () => {
  function setup(currentVersion: string, history: Release[] = [], body = Buffer.alloc(1024, 3)) {
    const updates = path.join(mkdtempSync(path.join(root, "data-")), "updates");
    mkdirSync(updates, { recursive: true });
    const log: string[] = [];
    const states: UpdateState[] = [];
    let now = 0;
    const updater = new Updater({
      currentVersion,
      publicKey: pub(keyA),
      updatesDir: updates,
      skipped: () => [],
      freeBytes: async () => 10e9,
      activeWork: async () => ({ busy: false, reasons: [] }),
      backup: async () => (log.push("backup"), { ok: true }),
      stopChief: async () => void log.push("stop"),
      handOff: async (file) => (log.push(`install ${path.basename(file)}`), { ok: true, via: "helper" }),
      onState: (s) => states.push(s),
      history: () => history,
      now: () => (now += 100),
    });
    const put = (name: string, data = body) => writeFileSync(path.join(updates, name), data);
    return { updater, updates, log, states, put };
  }

  it("keeps the new package and the installed version's own, and never touches other files", async () => {
    const { updater, updates, put } = setup("1.1.0");
    for (const v of ["1.0.0", "1.1.0", "1.2.0"]) put(packageName(v));
    put(`${packageName("0.9.0")}.part`);
    put("notes.txt");
    const removed = await updater.prune([packageName("1.2.0")]);
    expect(removed.sort()).toEqual([packageName("0.9.0") + ".part", packageName("1.0.0")].sort());
    expect(readdirSync(updates).sort()).toEqual([packageName("1.1.0"), packageName("1.2.0"), "notes.txt"].sort());
  });

  it("offers earlier versions whose package is still here, and goes back after checking it again", async () => {
    const body = Buffer.alloc(1024, 3);
    const older = manifest("1.0.0", {}, body) as unknown as Release;
    const newer = manifest("1.2.0", {}, body) as unknown as Release;
    const { updater, log, put, updates } = setup("1.1.0", [newer, older], body);
    expect(await updater.rollbackOptions()).toEqual([]);
    put(packageName("1.0.0"), body);
    put(packageName("1.2.0"), body);
    expect((await updater.rollbackOptions()).map((o) => o.version)).toEqual(["1.0.0"]);
    await updater.rollback("1.0.0");
    expect(log).toEqual(["backup", "stop", `install ${packageName("1.0.0")}`]);
    // A kept package that no longer matches its description is deleted, not installed.
    put(packageName("1.0.0"), Buffer.alloc(1024, 9));
    const bad = await updater.rollback("1.0.0");
    expect(bad).toMatchObject({ status: "error" });
    expect(existsSync(path.join(updates, packageName("1.0.0")))).toBe(false);
    expect(await updater.rollback("0.5.0")).toMatchObject({ status: "error" });
  });
});
