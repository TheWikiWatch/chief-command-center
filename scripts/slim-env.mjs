// The environment for a step that runs nested `npm run …` on Windows: PATH without duplicates and without the
// node_modules\.bin folders npm added on the way in. Each nested `npm run` prepends a few hundred characters, and
// cmd.exe stops finding programs once PATH passes 8191 ("'tsc' is not recognized"). A long PATH (a PC with many
// tools installed) plus `npm run check`'s three levels was enough. Folders that no longer exist go too: they can't
// hold a program, and throwaway Hermes homes from test runs (deleted since) used to pile up there.
//
// Nothing of a live Chief either. A shell opened from Chief's own terminal (the owner can start a coding session from
// a chat) carries the live gateway's environment: HERMES_HOME names the live profile, CHIEF_DASHBOARD_PORT the live
// bridge, COMMAND_CENTER_HOME_CHANNEL the owner's chat id (bridge tests then answered as the owner and waited out
// their polls), the messaging platforms' settings a test gateway would connect with, and PATH leads first to the live
// Hermes's own Python and to the installed app's tools, which no other program may run (Windows refuses anything
// inside an MSIX package's folder). Tests, the smoke test and the release see none of it.
import { existsSync } from "node:fs";
import path from "node:path";

/** Hermes's variables, its platforms' settings and the app's runtime settings; CHIEF_TEST_* and the developer
 * overrides below stay. */
const INHERITED = /^(_?HERMES_|OBSIDIAN_|TERMINAL_|CHIEF_|COMMAND_CENTER_|DISCORD_|TELEGRAM_|SLACK_|WHATSAPP_|SIGNAL_|MATRIX_|MATTERMOST_)/i;
const KEPT = /^CHIEF_(TEST_|BRIDGE_URL$|BRIDGE_TOKEN$|PAYLOAD_DIR$)/i;

/** The Hermes root a HERMES_HOME belongs to (`<root>\profiles\<name>` or the root itself), lower-case. */
function hermesRoot(home) {
  const full = path.resolve(home).replace(/[\\/]+$/, "");
  return (/^(.*)[\\/]profiles[\\/][^\\/]+$/i.exec(full)?.[1] || full).toLowerCase();
}

export function slimEnv(env = process.env) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  const home = Object.entries(env).find(([k]) => k.toUpperCase() === "HERMES_HOME")?.[1];
  const root = home ? hermesRoot(home) : "";
  const seen = new Set();
  const parts = String(env[key] || "")
    .split(path.delimiter)
    .filter((p) => {
      const norm = p.trim().replace(/[\\/]+$/, "").toLowerCase();
      if (!norm || seen.has(norm) || /[\\/]node_modules[\\/]\.bin$/.test(norm) || /node-gyp-bin$/.test(norm)) return false;
      if (/[\\/]program files[\\/]windowsapps[\\/]/.test(norm)) return false;
      if (root && (norm === root || norm.startsWith(`${root}\\`) || norm.startsWith(`${root}/`))) return false;
      seen.add(norm);
      return norm.includes("%") || existsSync(p.trim());
    });
  const kept = Object.entries(env).filter(([k]) => !INHERITED.test(k) || KEPT.test(k));
  return { ...Object.fromEntries(kept), [key]: parts.join(path.delimiter) };
}
