import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * The shell's own settings: `app\desktop.json` (separate from the dashboard's settings.json, so the two
 * processes never write the same file).
 *
 * A damaged file used to reset the app silently, and the next save wrote the defaults over it (an adopted install lost
 * its Hermes root). Each save now goes through a temporary file that reaches the disk before it replaces the real one,
 * the previous file stays as `desktop.json.bak`, a file that can't be read is read from that backup, and a file that
 * can't be read either way is never saved over.
 */
export type DesktopSettings = {
  /** An adopted Hermes root (the migration); empty = the app's own `hermes\` folder. */
  hermesRoot: string;
  /** An adopted install shares its gateway lock with its other launchers; a new install has its own. */
  sharedGatewayLock: boolean;
  /** Pass the user's PATH to Hermes (adopted installs whose skills rely on it). */
  inheritUserPath: boolean;
  /** An existing Hermes install the app took over (packaging/migrate/adopt.py): the owner's own skills, routines,
   * toolkit and Fleet Health jobs are kept, and the app adds none of its own alongside them. */
  adopted: boolean;
  /** Fleet Health's report folder and ledger, when the install already has them; empty = the app's own. */
  learningDir: string;
  learningTool: string;
  /** Run `learningTool` instead of the app's ledger. Off: an adopted install keeps its report folder and history,
   * but its ledger job runs the app's ledger, so ledger fixes arrive with updates (the bridge switches the job). */
  ownLedger: boolean;
  /** Where the app's own backups go (the pre-update one included); empty = beside the app's data. */
  backupDir: string;
  ports: { ui: number; bridge: number };
  /** Extra settings for the dashboard server (optional connectors), e.g. CHIEF_OPS_URL. Never secrets. */
  webEnv: Record<string, string>;
  closeNoticeShown: boolean;
  startAtLogin: boolean;
  /** Where updates come from, when the owner chose a source (a GitHub releases repository or a folder on this PC).
   * Empty = the source this build ships with, the public releases repository (release-source.ts effectiveFeed). */
  updateFeed: string;
  skippedVersions: string[];
  /** Download, back up and stage a new release in the background as soon as a check finds it (the restart stays the owner's click). */
  prepareUpdates: boolean;
  /** Early updates: also take releases published as prereleases (the owner's soak before testers get them). */
  earlyUpdates: boolean;
  /** The app version that last opened this data, and the data schema it wrote. */
  lastVersion: string;
  dataSchema: number;
  /** The Hermes build (payload commit) that last opened this data: an update that keeps it can't migrate anything. */
  lastHermes: string;
  /** What the last successful provisioning depended on (runtime.ts provisionKey); unchanged, a start skips it. */
  provisionKey: string;
  /** Starts of this version that haven't reached the dashboard yet, and the last version that did (a healthy start). */
  bootAttempts: { version: string; count: number } | null;
  healthyVersion: string;
  /** Phone access while it's on: Serve's port, the dashboard port it points at, and this PC's Tailscale name (the
   * only Host the dashboard accepts phone requests for). */
  phoneServe: { port: number; uiPort: number; host?: string } | null;
  /** The app's look's mode (the dashboard says it, app_look.py): the window's background and title-bar symbols at the next start. */
  themeMode: "dark" | "light" | "system";
  /** The assistant's name the dashboard last said (guards.ts validAssistantName), for notifications, the tray and
   * dialogs at the next start too; empty = "Chief". */
  assistantName: string;
};

export const DEFAULTS: DesktopSettings = {
  hermesRoot: "",
  sharedGatewayLock: false,
  inheritUserPath: false,
  adopted: false,
  learningDir: "",
  learningTool: "",
  ownLedger: false,
  backupDir: "",
  ports: { ui: 3000, bridge: 7790 },
  webEnv: {},
  closeNoticeShown: false,
  startAtLogin: true,
  updateFeed: "",
  skippedVersions: [],
  prepareUpdates: true,
  earlyUpdates: false,
  themeMode: "dark",
  assistantName: "",
  lastVersion: "",
  dataSchema: 0,
  lastHermes: "",
  provisionKey: "",
  bootAttempts: null,
  healthyVersion: "",
  phoneServe: null,
};

function parse(text: string): Partial<DesktopSettings> {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not a settings object");
  return value as Partial<DesktopSettings>;
}

/** `text` into a temporary file that is on the disk before it replaces `file`: a crash or a power cut leaves the old file or the new one, never half of one. */
function writeDurably(file: string, text: string) {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export class Store {
  private file: string;
  value: DesktopSettings;
  /** "restored": desktop.json couldn't be read and its backup was used; "unreadable": neither could be, so the app runs
   * on defaults and never saves over the file (it may still be fixed by hand). */
  readonly problem: "" | "restored" | "unreadable" = "";
  /** The file on disk is one this store read or wrote, so it may become the backup. */
  private sound = false;

  constructor(appDir: string) {
    this.file = path.join(appDir, "desktop.json");
    let text: string | null = null;
    let failed = false;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (e) {
      failed = (e as NodeJS.ErrnoException).code !== "ENOENT"; // there, but locked or out of reach
    }
    let raw: Partial<DesktopSettings> | null = null;
    if (text?.trim()) {
      try {
        raw = parse(text);
        this.sound = true;
      } catch {
        failed = true;
      }
    }
    if (!raw && (failed || text !== null)) {
      // Damaged, out of reach or empty: the last good file, when there is one.
      try {
        raw = parse(readFileSync(`${this.file}.bak`, "utf8"));
        this.problem = "restored";
      } catch {
        // An empty file held nothing to keep (a first run, then); anything else may still be fixed by hand.
        if (failed) this.problem = "unreadable";
      }
    }
    raw ??= {};
    this.value = { ...DEFAULTS, ...raw, ports: { ...DEFAULTS.ports, ...(raw.ports || {}) }, webEnv: { ...(raw.webEnv || {}) } };
  }

  save(change: Partial<DesktopSettings>): DesktopSettings {
    this.value = { ...this.value, ...change };
    if (this.problem === "unreadable") return this.value;
    mkdirSync(path.dirname(this.file), { recursive: true });
    if (this.sound) {
      try {
        copyFileSync(this.file, `${this.file}.bak`);
      } catch {
        /* no backup this time; the save still goes ahead */
      }
    }
    writeDurably(this.file, JSON.stringify(this.value, null, 2));
    this.sound = true;
    return this.value;
  }
}
