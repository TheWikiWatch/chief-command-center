import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, promises as fs } from "node:fs";
import path from "node:path";

import type { ActiveWork } from "./active-work";
import { folderSource, SourceError, type ReleaseSource } from "./release-source";

/**
 * "Update available — install?" (PLAN §8 "App update flow"). Nothing installs without the owner's click.
 *
 * 1. Check: read the feed's release.json and verify its Ed25519 signature against the pinned key. A failed
 *    check says why; the app never claims "up to date" without a successful check.
 * 2. Download to `updates\` with resume, then verify the package's SHA-256 against the signed manifest; a
 *    mismatch deletes the file.
 * 3. Preflight: free space, and work in progress (never interrupt a turn unless the owner says so).
 * 4. Backup, then stop Chief and hand the package to Windows, which verifies its signature, installs it and
 *    relaunches the app.
 *
 * Releases come from a folder (local or network) or a private GitHub repository that holds only releases,
 * read with a per-person read-only key (release-source.ts).
 */
export type Release = {
  format: "chief-release";
  format_version: number;
  version: string;
  published: string;
  notes: string;
  package: { file: string; bytes: number; sha256: string };
  hermes: { base_version: string; commit: string };
  data: { schema: number; min_reader: string };
  /** Which pinned key signed it (release-key.ts); older manifests have none and are checked against every key. */
  signing?: { key_id?: string };
};

/** A pinned release key; `expires` (ISO date): manifests published after it don't verify with this key. */
export type ReleaseKey = { id: string; publicKey: string; expires?: string };
export type ReleaseKeys = string | ReleaseKey[];

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date"; checkedAt: number }
  | { status: "available"; checkedAt: number; release: Release }
  | { status: "downloading"; release: Release; done: number; total: number }
  | { status: "ready"; release: Release; file: string }
  | { status: "busy"; release: Release; file: string; reasons: string[] }
  | { status: "installing"; release: Release; step: string }
  | { status: "error"; error: string; release?: Release };

export type UpdaterDeps = {
  /** A release folder (the closed-phase default). */
  feed?: () => string;
  /** Where releases come from: a folder or a private GitHub repo (release-source.ts); wins over `feed`. */
  source?: () => ReleaseSource | null;
  currentVersion: string;
  publicKey: ReleaseKeys;
  updatesDir: string;
  skipped: () => string[];
  freeBytes: (dir: string) => Promise<number>;
  activeWork: () => Promise<ActiveWork>;
  backup: (release: Release) => Promise<{ ok: boolean; error?: string }>;
  stopChief: () => Promise<void>;
  /** Brings Chief back after `stopChief` when the install fails, so a failed update never leaves it stopped. */
  startChief?: () => Promise<void>;
  install: (file: string) => Promise<{ ok: boolean; error?: string }>;
  onState?: (state: UpdateState) => void;
  /** The verified release descriptions this install keeps (release-history.ts), for "Go back to X.Y.Z". */
  history?: () => Release[];
  now?: () => number;
  /** Each release description that verified (newer or not): the update history keeps it. */
  onVerified?: (bytes: Buffer, signature: string, release: Release) => void;
};

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function verifiesWith(bytes: Buffer, signatureB64: string, publicKeyB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
    return verify(null, bytes, key, Buffer.from(signatureB64.trim(), "base64"));
  } catch {
    return false;
  }
}

/**
 * Check a release description's signature against the pinned key(s), then its shape. With a key list, the
 * manifest's `signing.key_id` picks the key (an unknown id fails); a manifest without one is tried against every
 * key; a key whose `expires` is before the manifest's `published` date doesn't count.
 */
export function verifyRelease(bytes: Buffer, signatureB64: string, keys: ReleaseKeys): Release {
  const list: ReleaseKey[] = typeof keys === "string" ? [{ id: "", publicKey: keys }] : keys;
  let claimed: Partial<Release> = {};
  try {
    claimed = JSON.parse(bytes.toString("utf8")) as Partial<Release>;
  } catch {
    claimed = {};
  }
  const keyId = claimed.signing?.key_id;
  const published = Date.parse(String(claimed.published || ""));
  const usable = list.filter((k) => (keyId && typeof keys !== "string" ? k.id === keyId : true)).filter((k) => !k.expires || !(published > Date.parse(k.expires)));
  if (!usable.some((k) => verifiesWith(bytes, signatureB64, k.publicKey))) {
    throw new UpdateError("This update couldn't be verified (its signature doesn't match). Nothing was downloaded.");
  }
  const release = JSON.parse(bytes.toString("utf8")) as Release;
  if (release.format !== "chief-release" || !/^\d+\.\d+\.\d+$/.test(release.version) || !/^[a-f0-9]{64}$/.test(release.package?.sha256 || "")) {
    throw new UpdateError("This update's description is malformed.");
  }
  if (path.basename(release.package.file) !== release.package.file) throw new UpdateError("This update's description is malformed.");
  return release;
}

export class UpdateError extends Error {}

/** A release's package file name (packaging/release/release-tool.mjs names them so). */
export function packageName(version: string): string {
  return `ChiefCommandCenter-${version}.msix`;
}

/** Download progress reaches the page at most this often. */
export const PROGRESS_EVERY_MS = 250;

/** An earlier version this PC can go back to: its verified description and its package, still on disk. */
export type RollbackOption = { version: string; published: string; file: string };

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class Updater {
  state: UpdateState = { status: "idle" };

  constructor(private readonly deps: UpdaterDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Earlier versions whose verified package is still in `updates\`, newest first (Settings → "Go back to X.Y.Z"). */
  async rollbackOptions(): Promise<RollbackOption[]> {
    const out: RollbackOption[] = [];
    for (const release of this.deps.history?.() ?? []) {
      if (compareVersions(release.version, this.deps.currentVersion) >= 0) continue;
      const file = path.join(this.deps.updatesDir, release.package.file);
      try {
        if ((await fs.stat(file)).size !== release.package.bytes) continue;
      } catch {
        continue;
      }
      out.push({ version: release.version, published: release.published, file });
    }
    return out.sort((a, b) => compareVersions(b.version, a.version));
  }

  /**
   * Go back to an earlier version: its package is checked against its signed description again, then it installs
   * like an update (backup first, Chief stopped, Windows installs it and relaunches the app).
   */
  async rollback(version: string, force = false): Promise<UpdateState> {
    const option = (await this.rollbackOptions()).find((o) => o.version === version);
    const release = this.deps.history?.().find((r) => r.version === version);
    if (!option || !release) return this.set({ status: "error", error: `Version ${version} isn't kept on this PC any more, so the app can't go back to it.` });
    if ((await sha256(option.file)) !== release.package.sha256) {
      await fs.rm(option.file, { force: true });
      return this.set({ status: "error", error: `The kept package for ${version} doesn't match its description, so it was deleted.` });
    }
    this.set({ status: "ready", release, file: option.file });
    return this.install(force);
  }

  private source(): ReleaseSource | null {
    if (this.deps.source) return this.deps.source();
    const feed = this.deps.feed?.() || "";
    return feed ? folderSource(feed) : null;
  }

  private set(state: UpdateState): UpdateState {
    this.state = state;
    this.deps.onState?.(state);
    return state;
  }

  async check(): Promise<UpdateState> {
    const source = this.source();
    if (!source) return this.set({ status: "error", error: "Couldn't check for updates: no update source is set." });
    this.set({ status: "checking" });
    let bytes: Buffer;
    let sig: string;
    try {
      await source.refresh();
      bytes = await source.read("release.json");
      sig = (await source.read("release.json.sig")).toString("utf8");
    } catch (e) {
      const why = e instanceof SourceError ? e.message : `the release source (${source.label}) isn't reachable.`;
      return this.set({ status: "error", error: `Couldn't check for updates: ${why}` });
    }
    let release: Release;
    try {
      release = verifyRelease(bytes, sig, this.deps.publicKey);
    } catch (e) {
      return this.set({ status: "error", error: e instanceof Error ? e.message : "This update couldn't be verified." });
    }
    this.deps.onVerified?.(bytes, sig, release);
    const newer = compareVersions(release.version, this.deps.currentVersion) > 0;
    if (!newer || this.deps.skipped().includes(release.version)) return this.set({ status: "up-to-date", checkedAt: Date.now() });
    return this.set({ status: "available", checkedAt: Date.now(), release });
  }

  async download(): Promise<UpdateState> {
    if (this.state.status !== "available" && this.state.status !== "error") return this.state;
    const release = this.state.release;
    if (!release) return this.state;
    const source = this.source();
    if (!source) return this.set({ status: "error", release, error: "Couldn't download the update: no update source is set." });
    const target = path.join(this.deps.updatesDir, release.package.file);
    const part = `${target}.part`;
    await fs.mkdir(this.deps.updatesDir, { recursive: true });
    if (existsSync(target) && (await sha256(target)) === release.package.sha256) return this.set({ status: "ready", release, file: target });
    let have = 0;
    try {
      have = (await fs.stat(part)).size;
    } catch {
      have = 0;
    }
    if (have > release.package.bytes) {
      await fs.rm(part, { force: true });
      have = 0;
    }
    const need = release.package.bytes - have;
    if ((await this.deps.freeBytes(this.deps.updatesDir)) < need + 64 * 1024 * 1024) {
      return this.set({ status: "error", release, error: `Not enough free space to download the update: it needs about ${Math.ceil(need / 1e6)} MB.` });
    }
    this.set({ status: "downloading", release, done: have, total: release.package.bytes });
    try {
      await source.refresh(); // a GitHub source learns the latest release's files here
      const input = await source.open(release.package.file, have);
      await new Promise<void>((resolve, reject) => {
        const output = createWriteStream(part, { flags: "a" });
        let done = have;
        let reported = 0;
        input.on("data", (chunk) => {
          done += (chunk as Buffer).length;
          if (done > release.package.bytes) input.destroy(new UpdateError("The update is larger than its description says."));
          // A few progress messages a second is plenty for the card (an 850 MB download is thousands of chunks).
          const now = this.now();
          if (now - reported >= PROGRESS_EVERY_MS || done >= release.package.bytes) {
            reported = now;
            this.set({ status: "downloading", release, done, total: release.package.bytes });
          }
        });
        input.on("error", reject);
        output.on("error", reject);
        output.on("finish", resolve);
        input.pipe(output);
      });
    } catch (e) {
      if (e instanceof UpdateError) await fs.rm(part, { force: true });
      if (e instanceof SourceError) return this.set({ status: "error", release, error: `Couldn't download the update: ${e.message}` });
      const full = (e as NodeJS.ErrnoException).code === "ENOSPC";
      return this.set({ status: "error", release, error: full ? "The disk filled up during the download. Free some space and try again; it resumes." : e instanceof UpdateError ? e.message : "The download stopped. Try again; it resumes where it stopped." });
    }
    if ((await fs.stat(part)).size !== release.package.bytes) {
      return this.set({ status: "error", release, error: "The download is incomplete. Try again; it resumes where it stopped." });
    }
    if ((await sha256(part)) !== release.package.sha256) {
      await fs.rm(part, { force: true });
      return this.set({ status: "error", release, error: "This update couldn't be verified (the download didn't match its checksum), so it was deleted." });
    }
    await fs.rename(part, target);
    await this.prune([release.package.file]);
    return this.set({ status: "ready", release, file: target });
  }

  /**
   * Packages kept in `updates\`: the one being installed and the installed version's own (what "Go back" needs).
   * Older packages and abandoned partial downloads go; files that aren't app packages are never touched.
   */
  async prune(keep: string[] = []): Promise<string[]> {
    const wanted = new Set([...keep, packageName(this.deps.currentVersion)]);
    const removed: string[] = [];
    let names: string[] = [];
    try {
      names = await fs.readdir(this.deps.updatesDir);
    } catch {
      return removed;
    }
    for (const name of names) {
      const base = name.replace(/\.part$/, "");
      if (!/^ChiefCommandCenter-\d+\.\d+\.\d+\.msix$/.test(base)) continue;
      if (wanted.has(base) && !name.endsWith(".part")) continue;
      if (name.endsWith(".part") && keep.includes(base)) continue; // a download that resumes
      await fs.rm(path.join(this.deps.updatesDir, name), { force: true }).catch(() => undefined);
      removed.push(name);
    }
    return removed;
  }

  /** `force`: the owner chose "Install now" although Chief is busy. */
  private installing: Promise<UpdateState> | null = null;

  /**
   * One install at a time: a second click (or the card's "install when the chief is done" retry, or the
   * same card in Settings) while one runs joins it instead of handing Windows the package twice.
   */
  install(force = false): Promise<UpdateState> {
    if (this.installing) return this.installing;
    this.installing = this.runInstall(force).finally(() => {
      this.installing = null;
    });
    return this.installing;
  }

  private async runInstall(force: boolean): Promise<UpdateState> {
    const state = this.state;
    if (state.status !== "ready" && state.status !== "busy") return state;
    const { release, file } = state;
    if (!force) {
      const work = await this.deps.activeWork();
      if (work.busy) return this.set({ status: "busy", release, file, reasons: work.reasons });
    }
    this.set({ status: "installing", release, step: "Backing up…" });
    const backup = await this.deps.backup(release);
    if (!backup.ok) return this.set({ status: "error", release, error: `The update wasn't installed because the backup before it failed: ${backup.error || "unknown error"}.` });
    this.set({ status: "installing", release, step: "Stopping Chief…" });
    await this.deps.stopChief();
    this.set({ status: "installing", release, step: "Installing…" });
    let result: { ok: boolean; error?: string };
    try {
      result = await this.deps.install(file);
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!result.ok) {
      this.set({ status: "installing", release, step: "Starting Chief again…" });
      await this.deps.startChief?.().catch(() => undefined);
      return this.set({ status: "error", release, error: result.error || "Windows couldn't install the update. The current version is still installed." });
    }
    return this.state;
  }
}
