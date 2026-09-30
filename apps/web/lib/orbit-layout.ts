/**
 * Seat positions for the desktop orbit (VISUAL-OVERHAUL §4.4, §12): one tilted ring up to 12
 * specialists, a second outer ring beyond that. Positions are percentages of the pane;
 * `depth` is 0 (back, top) to 1 (front, bottom) and drives scale, brightness and stacking.
 */
export type Seat = { x: number; y: number; depth: number; ring: 0 | 1; angle: number };

export const RING_RADII = {
  single: { rx: 35, ry: 30 },
  inner: { rx: 24, ry: 20 },
  outer: { rx: 41, ry: 35 },
};
const CENTER = { x: 50, y: 49 };

function ring(n: number, rx: number, ry: number, ringIndex: 0 | 1, offset: number): Seat[] {
  return Array.from({ length: n }, (_, i) => {
    const angle = -Math.PI / 2 + offset + (i / n) * Math.PI * 2;
    const y = CENTER.y + Math.sin(angle) * ry;
    return { x: CENTER.x + Math.cos(angle) * rx, y, depth: (Math.sin(angle) + 1) / 2, ring: ringIndex, angle };
  });
}

export function orbitLayout(count: number): Seat[] {
  if (count <= 0) return [];
  if (count <= 12) return ring(count, RING_RADII.single.rx, RING_RADII.single.ry, 0, 0);
  const inner = Math.ceil(count * 0.4);
  const outer = count - inner;
  return [...ring(inner, RING_RADII.inner.rx, RING_RADII.inner.ry, 0, 0), ...ring(outer, RING_RADII.outer.rx, RING_RADII.outer.ry, 1, Math.PI / outer)];
}

export function seatScale(depth: number) {
  return 0.84 + depth * 0.24;
}

/**
 * Which specialists get a seat in a capped orbit (the phone shows up to `max`): everyone working
 * always gets one (up to `hardMax`), the rest fill in roster order. Seats keep roster order, so a
 * bot starting work slides into the ring instead of reshuffling everyone.
 */
export function pickOrbitSeats<T extends { id: string; ring?: string }>(people: T[], max = 10, hardMax = 12): T[] {
  if (people.length <= max) return people;
  const working = people.filter((p) => p.ring === "working").slice(0, hardMax);
  const room = Math.max(0, max - working.length);
  const keep = new Set(working.map((p) => p.id));
  for (const p of people) {
    if (keep.size >= working.length + room) break;
    if (!keep.has(p.id)) keep.add(p.id);
  }
  return people.filter((p) => keep.has(p.id));
}

export const WORKING_GROUP = "Working now";

/** Fleet list groups: whoever is working first, then the usual sections without them. */
export function groupFleet<T extends { id: string; ring?: string; section?: string }>(people: T[]): [string, T[]][] {
  const working = people.filter((p) => p.ring === "working");
  const map = new Map<string, T[]>();
  for (const person of people) {
    if (person.ring === "working") continue;
    const key = person.section?.trim() || "Specialists";
    map.set(key, [...(map.get(key) || []), person]);
  }
  return working.length ? [[WORKING_GROUP, working], ...map.entries()] : [...map.entries()];
}

/** Shortest signed turn from angle a to angle b (radians). */
export function turn(a: number, b: number) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}
