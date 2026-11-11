import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/* Review A1: status text (warning, success, danger) passes WCAG AA (4.5:1 for small text) where it sits. */

const css = readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf8");
const blocks = {
  dark: /\n:root \{([\s\S]*?)\n\}/.exec(css)![1],
  light: /:root\[data-theme="light"\] \{([\s\S]*?)\n\}/.exec(css)![1],
};
const token = (mode: keyof typeof blocks, name: string) => {
  const m = new RegExp(`--c-${name}: (\\d+) (\\d+) (\\d+);`).exec(blocks[mode]);
  if (!m) throw new Error(`no ${mode} --c-${name}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const channel = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = ([r, g, b]: number[]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const tint = (fg: number[], bg: number[], alpha: number) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));

function components() {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".tsx")) files.push(full);
    }
  };
  walk(path.join(__dirname, "..", "components"));
  return files;
}

const lines = (test: (line: string) => boolean) =>
  components().flatMap((file) =>
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line, i) => ({ line, at: `${path.basename(file)}:${i + 1}` }))
      .filter(({ line }) => test(line))
      .map(({ at }) => at),
  );

it("status text reaches 4.5:1 on every surface in both modes, and on a /10 or /15 tint of itself", () => {
  for (const mode of ["dark", "light"] as const) {
    for (const name of ["warn", "ok", "danger"]) {
      const fg = token(mode, name);
      for (const surface of ["card", "raised", "canvas", "pane", "well"]) {
        const under = token(mode, surface);
        expect(contrast(fg, under), `${mode} ${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        // The notes and chips that sit on bg-ok/10, bg-warn/15 and the like.
        for (const alpha of [0.1, 0.15]) {
          expect(contrast(fg, tint(fg, under, alpha)), `${mode} ${name} on ${name}/${alpha * 100} over ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  }
});

it("status text never sits on a heavier tint of itself than /15", () => {
  expect(lines((line) => /\bbg-(ok|warn|danger)\/(1[6-9]|[2-9]\d)\b[^"`]*\btext-\1\b/.test(line))).toEqual([]);
});

it("--c-fg-4 (2.6:1 on white) is never the colour of text people read: only icons, list markers and disabled controls", () => {
  expect(lines((line) => /(^|[\s"`'])text-fg-4\b/.test(line) && !/Icon\b|rotate/.test(line))).toEqual([]);
});
