// Render the home-screen and notification icons from app/icon.svg with headless Edge (no packages).
// node docs/visual-overhaul/gen-pwa-icons.mjs  →  public/icons/*.png
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..");
const svg = readFileSync(path.join(root, "app", "icon.svg"), "utf8");
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const out = path.join(root, "public", "icons");
mkdirSync(out, { recursive: true });

// Maskable and Apple icons are full-bleed: the launcher crops them, so no rounded corners of our own.
// The hexagon's points sit 184px from the centre, inside the 204px maskable safe zone.
const fullBleed = inner.replace(/<rect[^>]*\/>/, '<rect width="512" height="512" fill="#0c0d10"/>');
// Android draws a notification badge from its alpha only: a white hexagon ring on transparent.
const badge = '<path fill="#fff" fill-rule="evenodd" d="M256 72l148 86v196l-148 86-148-86V158zM256 168l78 45v90l-78 45-78-45v-90z"/>';

const icons = [
  { name: "icon-192.png", size: 192, body: inner },
  { name: "icon-512.png", size: 512, body: inner },
  { name: "maskable-512.png", size: 512, body: fullBleed },
  { name: "apple-touch-icon.png", size: 180, body: fullBleed },
  { name: "badge-96.png", size: 96, body: badge },
];

const work = mkdtempSync(path.join(tmpdir(), "chief-icons-"));
try {
  // A fresh profile's first launch can render an error page instead of the file: warm it up first.
  const warm = path.join(work, "warm.html");
  writeFileSync(warm, "<!doctype html><body></body>");
  spawnSync(EDGE, ["--headless=new", "--disable-gpu", `--user-data-dir=${path.join(work, "profile")}`, `--screenshot=${path.join(work, "warm.png")}`, `file:///${warm.replace(/\\/g, "/")}`], { stdio: "ignore", timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 1500));
  for (const icon of icons) {
    const html = path.join(work, `${icon.name}.html`);
    writeFileSync(
      html,
      `<!doctype html><html><body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="${icon.size}" height="${icon.size}" style="display:block">${icon.body}</svg></body></html>`,
    );
    const target = path.join(out, icon.name);
    const run = spawnSync(
      EDGE,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--default-background-color=00000000",
        `--user-data-dir=${path.join(work, "profile")}`,
        `--window-size=${icon.size},${icon.size}`,
        `--screenshot=${target}`,
        `file:///${html.replace(/\\/g, "/")}`,
      ],
      { stdio: "ignore", timeout: 30_000 },
    );
    if (run.status !== 0) throw new Error(`Edge failed on ${icon.name} (${run.status})`);
    // The launcher can return before the browser has written the file.
    for (let i = 0; i < 100 && !(existsSync(target) && statSync(target).size > 0); i += 1) await new Promise((r) => setTimeout(r, 100));
    if (!existsSync(target)) throw new Error(`Edge wrote no ${icon.name}`);
    console.log(`${icon.name} ${statSync(target).size} bytes`);
  }
} finally {
  // Edge may still hold its temporary profile for a moment after the last screenshot.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    console.warn(`Could not remove ${work}; delete it later.`);
  }
}
