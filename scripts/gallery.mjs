// The capture gallery as a visual check (apps/web/scripts/capture-ui.mjs scenes against a running dashboard).
//
//   node scripts/gallery.mjs baseline   capture into .gallery/baseline (do this before a change)
//   node scripts/gallery.mjs check      capture into .gallery/current and compare with the baseline
//
// CAPTURE_ORIGIN picks the dashboard (default http://127.0.0.1:3102, the throwaway e2e one). `.gallery/` is
// git-ignored: galleries stay on this PC.
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
if (mode !== "baseline" && mode !== "check") {
  console.error("usage: node scripts/gallery.mjs baseline|check [scenarioRegex]");
  process.exit(2);
}
const gallery = path.join(repo, ".gallery");
const out = path.join(gallery, mode === "baseline" ? "baseline" : "current");
rmSync(out, { recursive: true, force: true });
const env = { ...process.env, CAPTURE_ORIGIN: process.env.CAPTURE_ORIGIN || "http://127.0.0.1:3102" };
const capture = spawnSync(process.execPath, [path.join(repo, "apps", "web", "scripts", "capture-ui.mjs"), out, process.argv[3] || ""], { stdio: "inherit", env });
if (capture.status !== 0) process.exit(capture.status || 1);
if (mode === "baseline") {
  console.log(`baseline saved in ${out}`);
  process.exit(0);
}
if (!existsSync(path.join(gallery, "baseline"))) {
  console.error("No baseline yet: run `node scripts/gallery.mjs baseline` first (before the change).");
  process.exit(2);
}
const sheets = path.join(gallery, "changes");
rmSync(sheets, { recursive: true, force: true });
const compare = spawnSync("python", [path.join(repo, "scripts", "gallery_compare.py"), path.join(gallery, "baseline"), out, sheets], { stdio: "inherit" });
process.exit(compare.status ?? 1);
