/**
 * Where a busy face looks: holds and quick jumps, the way eyes really move (saccades between fixations), never a
 * float. Eyes drifting on a slow sine read as dazed; holds and snaps read as attention.
 *
 *  - working: reading along a line in short jumps, a quick sweep back to the next line, and now and then a glance
 *    up as if weighing what it read;
 *  - thinking: looking up and to one side, held, a small shift now and then, sometimes the other side.
 *
 * Pure: the same mood, time and seed always give the same point, x and y from -1 to 1 (y down). The schedule is
 * built once per seed and loops.
 */
export type BusyMood = "working" | "thinking";
export type GazePoint = { x: number; y: number };
type Hold = { x: number; y: number; dur: number };

/** How long a jump between holds takes (seconds): fast enough to read as a snap. */
export const JUMP_S = 0.06;

function random(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function reading(seed: number): Hold[] {
  const r = random(seed);
  const out: Hold[] = [];
  for (let line = 0; line < 6; line++) {
    const y = 0.12 + (line % 2) * 0.14;
    const stops = 3 + Math.floor(r() * 2);
    for (let i = 0; i < stops; i++) {
      const x = -0.75 + (1.5 * i) / (stops - 1) + (r() - 0.5) * 0.12;
      out.push({ x, y, dur: 0.26 + r() * 0.24 });
    }
    // Every few lines, a glance up: weighing what it read.
    if (line % 3 === 2) out.push({ x: (r() - 0.5) * 0.4, y: -0.55, dur: 0.7 + r() * 0.5 });
  }
  return out;
}

function pondering(seed: number): Hold[] {
  const r = random(seed ^ 0x9e3779b9);
  const out: Hold[] = [];
  let side = r() < 0.5 ? -1 : 1;
  for (let i = 0; i < 5; i++) {
    out.push({ x: side * (0.5 + r() * 0.15), y: -0.6 - r() * 0.15, dur: 1.3 + r() * 1.0 });
    out.push({ x: side * (0.3 + r() * 0.15), y: -0.5 - r() * 0.1, dur: 0.6 + r() * 0.5 });
    if (r() < 0.45) out.push({ x: (r() - 0.5) * 0.2, y: -0.1, dur: 0.4 + r() * 0.3 });
    if (r() < 0.5) side = -side;
  }
  return out;
}

const cache = new Map<string, { holds: Hold[]; period: number }>();

function schedule(mood: BusyMood, seed: number) {
  const key = `${mood}:${seed}`;
  let s = cache.get(key);
  if (!s) {
    const holds = mood === "working" ? reading(seed) : pondering(seed);
    s = { holds, period: holds.reduce((n, h) => n + h.dur, 0) };
    if (cache.size > 64) cache.clear();
    cache.set(key, s);
  }
  return s;
}

/** The point a busy face looks at, at time `t` (seconds). */
export function scanGaze(mood: BusyMood, t: number, seed = 1): GazePoint {
  const { holds, period } = schedule(mood, seed);
  let u = ((t % period) + period) % period;
  for (let i = 0; i < holds.length; i++) {
    const h = holds[i];
    if (u < h.dur) {
      const prev = holds[(i - 1 + holds.length) % holds.length];
      const k = Math.min(1, u / JUMP_S);
      const e = k * k * (3 - 2 * k);
      return { x: prev.x + (h.x - prev.x) * e, y: prev.y + (h.y - prev.y) * e };
    }
    u -= h.dur;
  }
  const last = holds[holds.length - 1];
  return { x: last.x, y: last.y };
}

/** A stable number from a name, for `scanGaze`'s seed. */
export function gazeSeed(name: string): number {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}
