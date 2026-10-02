import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where everything is (PLAN §5 "New installs"). Packaged: inside the app's resources. Unpackaged (a developer,
 * or Phase 7's throwaway runs): the repo, plus CHIEF_PAYLOAD_DIR for a built Hermes payload.
 *
 *   %LOCALAPPDATA%\ChiefCommandCenter\     (CHIEF_DESKTOP_DATA overrides, e.g. for a throwaway run)
 *     hermes\          HERMES_HOME for a new install (an adopted install keeps its own, see desktop.json)
 *     app\             settings.json (shared with the dashboard server), desktop.json, secrets\, restore state
 *     locks\           this install's gateway lock directory
 *     logs\
 */
export type DesktopPaths = {
  data: string;
  appDir: string;
  secrets: string;
  locks: string;
  logs: string;
  payload: string;
  webServer: string;
  webStatic: string;
  plugins: string;
  backupEngine: string;
  provision: string;
  staticDir: string;
  /** The third-party notices the release generates (scripts/licenses.mjs); absent in a dev checkout until made. */
  notices: string;
  icon: string;
  /** The face alone, for the 16px tray (a whole tile doesn't read that small). */
  trayIcon: string;
};

export function resolvePaths(opts: { packaged: boolean; resourcesPath: string; appPath: string; env: NodeJS.ProcessEnv }): DesktopPaths {
  const { env } = opts;
  const local = env.LOCALAPPDATA || path.join(env.USERPROFILE || os.homedir(), "AppData", "Local");
  const data = env.CHIEF_DESKTOP_DATA ? path.resolve(env.CHIEF_DESKTOP_DATA) : path.join(local, "ChiefCommandCenter");
  const appDir = path.join(data, "app");
  const repo = path.resolve(opts.appPath, "..", "..");
  const res = opts.resourcesPath;
  const packaged = opts.packaged;
  const webRoot = packaged ? path.join(res, "web") : path.join(repo, "apps", "web", ".next", "standalone");
  return {
    data,
    appDir,
    secrets: path.join(appDir, "secrets"),
    locks: path.join(data, "locks"),
    logs: path.join(data, "logs"),
    payload: env.CHIEF_PAYLOAD_DIR ? path.resolve(env.CHIEF_PAYLOAD_DIR) : path.join(res, "payload"),
    webServer: path.join(webRoot, "server.js"),
    webStatic: webRoot,
    plugins: packaged ? path.join(res, "plugins") : path.join(repo, "hermes", "plugins"),
    backupEngine: packaged ? path.join(res, "backup") : path.join(repo, "backup"),
    provision: packaged ? path.join(res, "python", "provision.py") : path.join(opts.appPath, "python", "provision.py"),
    staticDir: path.join(opts.appPath, "static"),
    notices: packaged ? path.join(res, "THIRD_PARTY_NOTICES.md") : path.join(opts.appPath, "build", "THIRD_PARTY_NOTICES.md"),
    icon: packaged ? path.join(res, "icon.png") : path.join(repo, "apps", "web", "public", "icons", "icon-192.png"),
    trayIcon: packaged ? path.join(res, "tray.png") : path.join(repo, "apps", "web", "public", "icons", "tray-32.png"),
  };
}

export function missing(paths: DesktopPaths): string[] {
  const need: [string, string][] = [
    ["Hermes runtime", path.join(paths.payload, "bin", "hermes.exe")],
    ["dashboard server", paths.webServer],
    ["bridge plugin", path.join(paths.plugins, "chief-dashboard-bridge", "plugin.yaml")],
  ];
  return need.filter(([, p]) => !existsSync(p)).map(([name, p]) => `${name} (${p})`);
}
