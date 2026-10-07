import { mix, parseHex } from "@/lib/color";

/**
 * The Bubble face (docs/PLAN-2026-10-07 §2.3): a soft, slightly 3D body with simple eyes, floating over its own
 * shadow. Our own design in the spirit of the new "dots" characters, drawn in the same 40 × 44 box as the geometric
 * faces (so rings, dots and the "z" line up) and animated by the same face clock. Pure geometry and colour here;
 * the component is `BubbleFace` in components/bot-face.tsx.
 */

export const BUBBLE_BODIES = ["bean", "round", "drop", "pebble", "cloud", "tall"] as const;
export const BUBBLE_EYES = ["dot", "oval", "diamond", "happy", "sleepy"] as const;
export type BubbleBody = (typeof BUBBLE_BODIES)[number];
export type BubbleEyes = (typeof BUBBLE_EYES)[number];

/** Where the body rests: squash and stretch pivot on this point, and the shadow sits just under it. */
export const GROUND_Y = 37.5;

type Pt = [number, number];

const gauss = (d: number, width: number) => Math.exp(-(d * d) / (2 * width * width));
/** The signed angular distance between two angles, in -π..π. */
const angleDiff = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
/** A superellipse coordinate: `n` 2 is an ellipse, higher is squarer. */
const sup = (v: number, n: number) => Math.sign(v) * Math.abs(v) ** (2 / n);

/** Points around a body, clockwise from the right (SVG y grows downward, so "top" is angle −π/2). */
export function bodyPoints(body: BubbleBody, count = 48): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    let x: number;
    let y: number;
    switch (body) {
      case "bean": {
        // A kidney: a soft dent on the left side, the bottom a little heavier, a slight lean.
        x = 20.4 + 13.6 * sup(c, 2.2);
        y = 22.6 + 15 * sup(s, 2.2) + 0.9 * Math.max(0, s);
        x += 2.1 * gauss(angleDiff(a, Math.PI * 0.98), 0.42);
        x += 0.8 * s;
        break;
      }
      case "drop": {
        // Round below, drawn up to a soft point on top.
        const top = gauss(angleDiff(a, -Math.PI / 2), 0.38);
        x = 20 + 14 * c * (1 - 0.55 * top);
        y = 24.6 + 13 * s - 6.8 * top;
        break;
      }
      case "pebble":
        x = 20 + 15.6 * sup(c, 2.7);
        y = 24.2 + 12.4 * sup(s, 2.5) + 0.7 * Math.cos(2 * a + 0.6);
        break;
      case "cloud": {
        // Bumps along the upper half only; the bottom stays smooth so it sits.
        const bump = s < 0 ? 0.075 * Math.max(0, Math.cos(5 * a + 0.3)) * Math.min(1, -s * 2.5) : 0;
        x = 20 + 14.6 * c * (1 + bump);
        y = 23.8 + 13 * s * (1 + bump * 1.4);
        break;
      }
      case "tall":
        x = 20 + 11.6 * sup(c, 2.4);
        y = 21.4 + 16.2 * sup(s, 2.4);
        break;
      default:
        x = 20 + 14.6 * c;
        y = 22.9 + 14.6 * s;
    }
    pts.push([x, y]);
  }
  return pts;
}

/** A closed, smooth path through the points (Catmull–Rom as cubic Béziers). */
export function smoothClosedPath(pts: Pt[]): string {
  const n = pts.length;
  const f = (v: number) => v.toFixed(2);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1: Pt = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Pt = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d} Z`;
}

const PATHS = new Map<BubbleBody, string>();

/** The body outline (cached: six shapes, each computed once). */
export function bodyPath(body: BubbleBody): string {
  let d = PATHS.get(body);
  if (!d) {
    d = smoothClosedPath(bodyPoints(body));
    PATHS.set(body, d);
  }
  return d;
}

/** The body's bounds, for placing the eyes, cheeks and highlight on each silhouette. */
export function bodyBox(body: BubbleBody): { left: number; right: number; top: number; bottom: number } {
  const pts = bodyPoints(body);
  return {
    left: Math.min(...pts.map((p) => p[0])),
    right: Math.max(...pts.map((p) => p[0])),
    top: Math.min(...pts.map((p) => p[1])),
    bottom: Math.max(...pts.map((p) => p[1])),
  };
}

const LAYOUTS = new Map<BubbleBody, ReturnType<typeof computeLayout>>();

/** Where the face sits on a body: eye centres, eye gap, cheeks and the mouth line (cached per silhouette). */
export function faceLayout(body: BubbleBody) {
  let layout = LAYOUTS.get(body);
  if (!layout) {
    layout = computeLayout(body);
    LAYOUTS.set(body, layout);
  }
  return layout;
}

function computeLayout(body: BubbleBody) {
  const b = bodyBox(body);
  const cx = (b.left + b.right) / 2 + (body === "bean" ? 0.6 : 0);
  const h = b.bottom - b.top;
  // A drop's face sits lower (its top is the point); a tall body's eyes a little higher up its height.
  const eyeY = b.top + h * (body === "drop" ? 0.5 : body === "tall" ? 0.4 : 0.44);
  const gap = Math.min(9.6, (b.right - b.left) * 0.33);
  return {
    eyeL: [cx - gap / 2, eyeY] as Pt,
    eyeR: [cx + gap / 2, eyeY] as Pt,
    cheekL: [cx - gap * 0.86, eyeY + 4.4] as Pt,
    cheekR: [cx + gap * 0.86, eyeY + 4.4] as Pt,
    mouth: [cx, eyeY + 5.6] as Pt,
    highlight: [b.left + (b.right - b.left) * 0.3, b.top + h * 0.2] as Pt,
  };
}

/**
 * The body's paint, from one colour: a lit top and a shaded bottom (the radial body gradient), a rim light, the eyes
 * (the colour's own darkest shade, which reads softer than black) and the cheeks. A colour that isn't hex (an older
 * profile's hsl) falls back to a palette colour.
 */
export function bubblePaint(color: string) {
  const base = parseHex(color) ? color.toLowerCase() : "#00c9bf";
  return {
    base,
    light: mix(base, "#ffffff", 0.42),
    mid: base,
    shade: mix(base, "#0b0d12", 0.5),
    rim: mix(base, "#ffffff", 0.6),
    eye: mix(base, "#06070a", 0.86),
    cheek: mix(base, "#ff5f8a", 0.55),
  };
}

/**
 * An eye of a given style at the origin, `lid` its openness (2.3 is open, under 0.5 a blink, as in facePose) and
 * `scale` its width (widens when the face notices you). Returns an SVG path; dots and ovals are drawn as paths too, so
 * one element per eye serves every style.
 */
export function eyePath(style: BubbleEyes, lid: number, scale = 1): string {
  const open = Math.max(0.08, Math.min(1.25, lid / 2.3));
  const f = (v: number) => v.toFixed(2);
  const ellipse = (rx: number, ry: number) => `M${f(-rx)} 0 A${f(rx)} ${f(ry)} 0 1 0 ${f(rx)} 0 A${f(rx)} ${f(ry)} 0 1 0 ${f(-rx)} 0 Z`;
  switch (style) {
    case "oval":
      return ellipse(1.75 * scale, 2.7 * open);
    case "diamond": {
      const w = 2.1 * scale;
      const h = 2.7 * open;
      return `M0 ${f(-h)} L${f(w)} 0 L0 ${f(h)} L${f(-w)} 0 Z`;
    }
    case "happy": {
      // A closed, smiling eye (∩); a blink flattens it.
      const w = 2.2 * scale;
      const rise = 1.9 * Math.min(1, open);
      return `M${f(-w)} 0.9 Q0 ${f(0.9 - rise * 2)} ${f(w)} 0.9`;
    }
    case "sleepy": {
      const w = 2.2 * scale;
      return `M${f(-w)} 0 Q0 ${f(0.4 + 0.9 * Math.min(1, open))} ${f(w)} 0`;
    }
    default:
      return ellipse(2.15 * scale, 2.3 * open);
  }
}

/** Line eyes (happy, sleepy) are stroked; the others are filled. */
export const strokedEyes = (style: BubbleEyes) => style === "happy" || style === "sleepy";

/**
 * Squash and stretch for a mood at time `t`: positive squashes (wider, shorter), negative stretches. A celebrating
 * hop squashes as it lands and stretches in the air; speech stretches a little with loudness; at rest it breathes.
 */
export function squash(mood: string, t: number, breath: number, level: number): number {
  if (mood === "celebrating") {
    const hop = Math.abs(Math.sin(t * 6));
    return (1 - hop) ** 6 * 0.16 - hop * 0.05;
  }
  if (mood === "speaking" || mood === "listening") return -level * 0.06 + breath * 0.008;
  if (mood === "asleep") return 0.03 + breath * 0.02;
  return breath * 0.014;
}

/** How high it floats above its shadow (0 rests, about 2 at the top of a bob), from the mood. */
export function floatHeight(mood: string, t: number, phase: number): number {
  const p = t + phase;
  switch (mood) {
    case "asleep":
      return 0.2;
    case "failed":
      return 0.3 + 0.2 * Math.sin(p * 0.8);
    case "working":
      return 1.2 + 0.7 * Math.sin(p * 4.2);
    case "celebrating":
      return Math.abs(Math.sin(t * 6)) * 3.4;
    default:
      return 1.1 + 0.9 * Math.sin((p * Math.PI * 2) / 3.8);
  }
}
