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

/** Every opening tag of `tag` in a file, with the line it starts on. Braces are tracked, so an arrow function
 * inside a prop doesn't end the tag early. */
function openingTags(text: string, tag: RegExp): { line: number; tag: string }[] {
  const out: { line: number; tag: string }[] = [];
  for (const m of text.matchAll(tag)) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote && text[i - 1] !== "\\") quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push({ line: text.slice(0, m.index).split("\n").length, tag: text.slice(m.index, i + 1) });
  }
  return out;
}

const inUi = (file: string) => file.startsWith("components/ui/");

/** Text fields drawn inside another frame (a search box's magnifier row, the composer's capsule, an inline number):
 * the frame carries the field's look, so the control itself is bare on purpose. */
const BARE_FIELD_ALLOWED = new Set([
  "components/command-palette.tsx",
  "components/settings-panel.tsx",
  "components/today-pane.tsx",
  "components/vault/browser.tsx",
  "components/usage/usage-page.tsx",
  "components/chat/composer.tsx",
]);

/** Buttons that are not buttons in the design system's sense: a tab bar's items (their own pill), and the last-resort
 * error page, which has no stylesheet to rely on. */
const PLAIN_BUTTON_ALLOWED = new Set(["components/phone-nav.tsx", "app/global-error.tsx"]);

describe("design rules", () => {
  it("never sets text in all caps (sentence case everywhere)", () => {
    const offenders = files.filter((f) => /\buppercase\b|text-transform:\s*uppercase/.test(f.text)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("keeps backdrop blur to the surfaces that have a budget for it", () => {
    const offenders = files.filter((f) => /backdrop-blur|backdrop-filter/.test(f.text) && !BLUR_ALLOWED.has(f.file)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });

  it("draws every text field with the field primitive (field(), Input, Textarea, Select)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (inUi(f.file) || BARE_FIELD_ALLOWED.has(f.file) || !f.file.endsWith(".tsx")) continue;
      for (const { line, tag } of openingTags(f.text, /<(?:input|textarea|select)\b/g)) {
        if (/type="(?:file|hidden|checkbox|radio|range)"|className="hidden"/.test(tag)) continue;
        if (/\bfield\(|\bfieldClass\(/.test(tag)) continue;
        offenders.push(`${f.file}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives every button a pressed state (press, btn(), Button) unless it is a link, a radio, a tab or a menu item", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (inUi(f.file) || PLAIN_BUTTON_ALLOWED.has(f.file) || !f.file.endsWith(".tsx")) continue;
      for (const { line, tag } of openingTags(f.text, /<button\b/g)) {
        // The mic is its own control (hold to talk) with its own pressed look (`mic-btn`).
        if (/\bpress\b|\bbtn\(|\bACTION\b|\bmic-btn\b|role="(?:switch|radio|tab|menuitem|option)"|\bunderline\b/.test(tag)) continue;
        offenders.push(`${f.file}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("uses the radius tokens, never an arbitrary radius", () => {
    const offenders = files.filter((f) => f.file.endsWith(".tsx") && /\brounded-\[/.test(f.text)).map((f) => f.file);
    expect(offenders).toEqual([]);
  });
});
