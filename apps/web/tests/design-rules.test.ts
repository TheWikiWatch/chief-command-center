import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/* Design-system rules that are easy to break by accident (docs/design/VISUAL-OVERHAUL.md). */

const ROOT = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(tsx|ts|css)$/.test(name) ? [path] : [];
  });
}

const files = [...sources(join(ROOT, "components")), ...sources(join(ROOT, "app"))].map((path) => ({
  file: relative(ROOT, path).split(sep).join("/"),
  text: readFileSync(path, "utf8"),
}));

/** Where a backdrop blur is allowed: the glass surfaces and the few floating controls over busy backdrops. */
const BLUR_ALLOWED = new Set([
  "app/globals.css",
  "components/chief-chat.tsx",
  "components/command-shell.tsx",
  "components/fleet/team-sheet.tsx",
  "components/updates/update-card.tsx",
  "components/updates/update-history.tsx",
]);

describe("design rules", () => {
  it("never sets text in all caps (sentence case everywhere)", () => {
    const offenders = files.filter((f) => /\buppercase\b|text-transform:\s*uppercase/.test(f.text)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("keeps backdrop blur to the surfaces that have a budget for it", () => {
    const offenders = files.filter((f) => /backdrop-blur|backdrop-filter/.test(f.text) && !BLUR_ALLOWED.has(f.file)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });
});
