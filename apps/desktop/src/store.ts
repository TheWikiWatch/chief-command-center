import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The shell's own settings: `app\desktop.json` (separate from the dashboard's settings.json, so the two
 * processes never write the same file).
 */
export type DesktopSettings = {
  /** An adopted Hermes root (the migration); empty = the app's own `hermes\` folder. */
  hermesRoot: string;
  /** An adopted install shares its gateway lock with its other launchers; a new install has its own. */
  sharedGatewayLock: boolean;
  /** Pass the user's PATH to Hermes (adopted installs whose skills rely on it). */
  inheritUserPath: boolean;
  ports: { ui: number; bridge: number };
  /** Extra settings for the dashboard server (optional connectors), e.g. CHIEF_OPS_URL. Never secrets. */
  webEnv: Record<string, string>;
  closeNoticeShown: boolean;
  startAtLogin: boolean;
  /** Where updates come from: a release folder while the repo is closed (PLAN §8a). Empty = no checks. */
  updateFeed: string;
  skippedVersions: string[];
  /** The app version that last opened this data, and the data schema it wrote. */
  lastVersion: string;
  dataSchema: number;
};

export const DEFAULTS: DesktopSettings = {
  hermesRoot: "",
  sharedGatewayLock: false,
  inheritUserPath: false,
  ports: { ui: 3000, bridge: 7790 },
  webEnv: {},
  closeNoticeShown: false,
  startAtLogin: true,
  updateFeed: "",
  skippedVersions: [],
  lastVersion: "",
  dataSchema: 0,
};

export class Store {
  private file: string;
  value: DesktopSettings;

  constructor(appDir: string) {
    this.file = path.join(appDir, "desktop.json");
    let raw: Partial<DesktopSettings> = {};
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<DesktopSettings>;
    } catch {
      /* first run */
    }
    this.value = { ...DEFAULTS, ...raw, ports: { ...DEFAULTS.ports, ...(raw.ports || {}) }, webEnv: { ...(raw.webEnv || {}) } };
  }

  save(change: Partial<DesktopSettings>): DesktopSettings {
    this.value = { ...this.value, ...change };
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    renameSync(tmp, this.file);
    return this.value;
  }
}
