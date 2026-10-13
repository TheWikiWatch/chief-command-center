// The environment for a step that runs nested `npm run …` on Windows: PATH without duplicates and without the
// node_modules\.bin folders npm added on the way in. Each nested `npm run` prepends a few hundred characters, and
// cmd.exe stops finding programs once PATH passes 8191 ("'tsc' is not recognized"). A long PATH (a PC with many
// tools installed) plus `npm run check`'s three levels was enough. Folders that no longer exist go too: they can't
// hold a program, and throwaway Hermes homes from test runs (deleted since) used to pile up there.
import { existsSync } from "node:fs";
import path from "node:path";

export function slimEnv(env = process.env) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") || "PATH";
  const seen = new Set();
  const parts = String(env[key] || "")
    .split(path.delimiter)
    .filter((p) => {
      const norm = p.trim().replace(/[\\/]+$/, "").toLowerCase();
      if (!norm || seen.has(norm) || /[\\/]node_modules[\\/]\.bin$/.test(norm) || /node-gyp-bin$/.test(norm)) return false;
      seen.add(norm);
      return norm.includes("%") || existsSync(p.trim());
    });
  return { ...env, [key]: parts.join(path.delimiter) };
}
