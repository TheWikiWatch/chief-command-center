import { hashId, type BotIdentity } from "@/lib/bot-identity";

/**
 * Mouths for every face (PLAN-2026-09-26 Phase 2). Pure functions: a mood (and, while speaking,
 * the live audio) gives a target shape, the shape eases toward it every frame, and one closed path
 * with a fixed command structure draws it, so any shape morphs smoothly into any other.
 *
 * A shape is expressed in half-widths (W) of the face's mouth:
 *  w     width multiplier
 *  o     opening 0..1 (0 is a closed line)
 *  c     curve -1..1 (smile up, frown down)
 *  r     roundness 0..1 (corners pull in, an "o")
 *  dx    sideways shift, in W
 *  skew  one corner higher than the other, in W
 */
export type Mouth = { w: number; o: number; c: number; r: number; dx: number; skew: number };

/** What the audio sounds like right now, from band energies (see readBands in audio-level). */
export type Voice = { level: number; round: number; wide: number; hiss: number };

export type Bands = { low: number; mid: number; high: number; sib: number };

export type MouthMood = "idle" | "working" | "failed" | "thinking" | "listening" | "speaking" | "waiting" | "asleep" | "celebrating" | "notice";

export const CLOSED: Mouth = { w: 0.85, o: 0, c: 0.5, r: 0, dx: 0, skew: 0 };

type Personality = { width: number; smile: number; asym: number; side: number };
const personalities = new Map<string, Personality>();

/** Per-bot mouth personality from the profile id, like breathing and blinking. */
export function mouthPersonality(id: BotIdentity): Personality {
  const hit = personalities.get(id.seed);
  if (hit) return hit;
  const h = hashId(`${id.seed}:mouth`);
  const p = {
    width: 0.9 + ((h >>> 2) % 1000) / 1000 * 0.25,
    smile: 0.38 + ((h >>> 9) % 1000) / 1000 * 0.3,
    asym: (((h >>> 15) % 1000) / 1000 - 0.5) * 0.14,
    side: (h >>> 21) & 1 ? 1 : -1,
  };
  personalities.set(id.seed, p);
  return p;
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const sin = Math.sin;

/** Turn band energies into how the mouth should look (the spectral approach of real-time lip-sync). */
export function voiceFromBands(level: number, b: Bands): Voice {
  const total = b.low + b.mid + b.high + b.sib + 1e-4;
  const low = b.low / total;
  const bright = (b.mid + b.high) / total;
  const sib = b.sib / total;
  return {
    level: clamp(level),
    // Energy sitting low with little brightness: rounded lips (O, U, W).
    round: clamp((low - 0.42) * 2.6) * (1 - clamp(sib * 2)),
    // Mid/high formants dominant: spread lips (E, I).
    wide: clamp((bright - 0.4) * 2.4),
    // Sibilants (S, F, SH) are loud up top but the jaw stays nearly shut.
    hiss: clamp((sib - 0.24) * 3) * clamp(1.2 - level * 1.5),
  };
}

/** A believable voice when no meter is running: syllables at ~4–5 Hz with drift, not a clean sine. */
export function fakeVoice(t: number): Voice {
  const syllable = Math.max(0, sin(t * 27.5) * 0.55 + sin(t * 17.3 + 1.1) * 0.35 + 0.25);
  const phrase = 0.55 + 0.45 * Math.max(0, sin(t * 2.3) * 0.7 + sin(t * 0.9 + 0.4) * 0.5);
  return {
    level: clamp(syllable * phrase),
    round: clamp(0.5 + 0.5 * sin(t * 3.7)) * 0.7,
    wide: clamp(0.5 + 0.5 * sin(t * 5.3 + 2)) * 0.7,
    hiss: 0,
  };
}

/** The shape a mood wants right now. `listen` is the mic level while listening. */
export function mouthTarget(mood: MouthMood, t: number, id: BotIdentity, voice: Voice | null, listen = 0): Mouth {
  const me = mouthPersonality(id);
  const p = t + id.phase;
  const base: Mouth = { w: 0.85 * me.width, o: 0, c: me.smile, r: 0, dx: 0, skew: me.asym };
  switch (mood) {
    case "idle": {
      // Now and then the smile widens a little, timed off the bot's own glance rhythm.
      const flicker = Math.pow(Math.max(0, sin(p * id.glance * 1.3)), 12);
      return { ...base, c: me.smile + flicker * 0.22, w: base.w + flicker * 0.08 };
    }
    case "working":
      return { ...base, w: 0.66 * me.width, c: 0.04, dx: 0.14 * me.side, skew: me.asym + 0.06 * me.side };
    case "thinking":
      // A small "hmm": short, slightly lopsided, drifting side to side.
      return { ...base, w: 0.46, o: 0.03, c: -0.1, r: 0.15, dx: sin(t * 0.9) * 0.3, skew: 0.14 * me.side };
    case "failed":
      return { ...base, w: 0.72 * me.width, c: -0.72, skew: me.asym * 0.5 };
    case "listening":
      return { ...base, w: 0.7 * me.width, o: 0.16 + listen * 0.28, c: 0.28, r: 0.2 };
    case "waiting":
      return { ...base, w: 0.6, o: 0.78, c: 0, r: 1, skew: 0 };
    case "asleep": {
      const breath = 0.5 + 0.5 * sin((t * Math.PI * 2) / 6);
      return { ...base, w: 0.5, o: 0.4 + breath * 0.32, c: 0, r: 1, skew: 0 };
    }
    case "celebrating": {
      const hop = Math.abs(sin(t * 6));
      return { ...base, w: 1.12 * me.width, o: 0.5 + hop * 0.22, c: 0.85, r: 0, skew: 0 };
    }
    case "notice":
      return { ...base, w: 1.0 * me.width, o: 0.14, c: 0.85, r: 0 };
    case "speaking": {
      const v = voice ?? fakeVoice(t);
      const open = v.level * (1 - v.hiss * 0.8);
      return {
        w: clamp(0.74 + v.wide * 0.34 - v.round * 0.22 + v.hiss * 0.1, 0.5, 1.2) * me.width,
        o: Math.max(0.05, open),
        c: 0.18,
        r: clamp(v.round * (0.5 + open)),
        dx: 0,
        skew: me.asym * 0.5,
      };
    }
    default:
      return base;
  }
}

/**
 * Ease `cur` toward `target` over `dt` seconds. Speech opens fast and closes slower (an asymmetric
 * envelope reads as talking; symmetric smoothing reads as a flapping puppet). Mood changes glide.
 */
export function stepMouth(cur: Mouth, target: Mouth, dt: number, speaking: boolean): Mouth {
  const k = (tau: number) => 1 - Math.exp(-Math.max(0, dt) / tau);
  const shape = k(speaking ? 0.05 : 0.14);
  const open = speaking ? k(target.o > cur.o ? 0.03 : 0.09) : k(0.12);
  const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
  return {
    w: lerp(cur.w, target.w, shape),
    o: lerp(cur.o, target.o, open),
    c: lerp(cur.c, target.c, shape),
    r: lerp(cur.r, target.r, shape),
    dx: lerp(cur.dx, target.dx, shape),
    skew: lerp(cur.skew, target.skew, shape),
  };
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/**
 * One closed path: corner → upper lip → corner → lower lip → close. Always `M C C Z` so every
 * shape interpolates. Drawn with fill and a round stroke of the same colour, a closed mouth
 * (o = 0) is a clean line of the stroke's width and an open one fills.
 */
export function mouthPath(m: Mouth, cx: number, cy: number, W: number): string {
  const hw = W * m.w * (1 - 0.18 * m.r);
  const x = cx + m.dx * W;
  // Smile: corners up, middle down (and the reverse for a frown).
  const cornerY = cy - m.c * 0.32 * W;
  const midY = cy + m.c * 0.22 * W;
  const H = m.o * W * (1 + 0.35 * m.r);
  const upperMid = midY - H * 0.32;
  const lowerMid = midY + H * 0.68;
  // A cubic whose control points share a y passes the midpoint at (y0 + 3Y) / 4.
  const ctrl = (mid: number) => (4 * mid - cornerY) / 3;
  const k = 0.52 + 0.46 * m.r;
  const lx = x - hw;
  const rx = x + hw;
  const ly = cornerY + m.skew * W;
  const ry = cornerY - m.skew * W;
  const u = ctrl(upperMid);
  const l = ctrl(lowerMid);
  return (
    `M${f(lx)} ${f(ly)}` +
    `C${f(x - hw * k)} ${f(u)} ${f(x + hw * k)} ${f(u)} ${f(rx)} ${f(ry)}` +
    `C${f(x + hw * k)} ${f(l)} ${f(x - hw * k)} ${f(l)} ${f(lx)} ${f(ly)}Z`
  );
}

/** Stroke width in the face's own units: `units` normally, never thinner than `minPx` on screen. */
export function mouthStroke(units: number, viewBox: number, sizePx: number, minPx = 1.1) {
  return Math.max(units, (minPx * viewBox) / Math.max(1, sizePx));
}
