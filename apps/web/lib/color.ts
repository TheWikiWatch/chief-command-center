/**
 * The chief's color, everywhere it glows: the face, the ring around it, the chat's aurora and the Fleet orbit's
 * rays all come from one color, so they always match. Crimson (the accent) stays for "needs you" and "active".
 */

/** The canvas every glow sits on (`--color-canvas`). */
export const CANVAS = "#09090b";

/** Glows and rings need at least this contrast against the canvas (WCAG non-text contrast). */
export const MIN_GLOW_CONTRAST = 3;

type RGB = [number, number, number];

export function parseHex(color: string): RGB | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
}

function toHex(rgb: RGB): string {
  return `#${rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("")}`;
}

function luminance([r, g, b]: RGB): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two hex colors (1 to 21); 1 when either doesn't parse. */
export function contrast(a: string, b: string): number {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return 1;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` mixed with `b` (0 is all `a`, 1 is all `b`), in sRGB. */
export function mix(a: string, b: string, amount: number): string {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return a;
  return toHex(x.map((v, i) => v + (y[i] - v) * amount) as RGB);
}

/**
 * A color that glows visibly on the canvas: a chosen color too dark to see (a navy chief) is lifted toward white
 * just enough. Colors that aren't hex pass through untouched.
 */
export function glowColor(color: string): string {
  if (!parseHex(color)) return color;
  if (contrast(color, CANVAS) >= MIN_GLOW_CONTRAST) return color.toLowerCase();
  for (let step = 1; step <= 20; step++) {
    const lifted = mix(color, "#ffffff", step / 20);
    if (contrast(lifted, CANVAS) >= MIN_GLOW_CONTRAST) return lifted;
  }
  return "#ffffff";
}

/** The Fleet orbit's rays and bloom for a chief color: the color, sinking into the canvas. */
export function raysPalette(color: string): { colors: string[]; bloom: string } {
  const base = parseHex(color) ? glowColor(color) : "#8a3030";
  return {
    colors: [mix(base, CANVAS, 0.45), mix(base, CANVAS, 0.65), mix(base, CANVAS, 0.85), CANVAS],
    bloom: mix(base, CANVAS, 0.8),
  };
}
