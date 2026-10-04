import { expect, it } from "vitest";

import { JUMP_S, gazeSeed, scanGaze } from "@/lib/eye-scan";

// The owner: busy eyes "bounce up and down and kind of look dumb". They drifted on a slow sine; real attention
// is holds and quick jumps.

const samples = (mood: "working" | "thinking", seconds: number, step = 0.01) =>
  Array.from({ length: Math.round(seconds / step) }, (_, i) => scanGaze(mood, i * step, gazeSeed("Nova")));

it("holds still most of the time and jumps quickly between holds", () => {
  for (const mood of ["working", "thinking"] as const) {
    const pts = samples(mood, 30);
    const moving = pts.slice(1).filter((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y) > 1e-6).length;
    expect(moving / pts.length).toBeLessThan(mood === "working" ? 0.25 : 0.1); // mostly holds, unlike a sine
  }
  // A jump completes within JUMP_S.
  const pts = samples("working", 30, JUMP_S / 3);
  const steps = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
  expect(Math.max(...steps)).toBeGreaterThan(0.1);
});

it("reads along a line while working and looks up to one side while thinking", () => {
  const work = samples("working", 30);
  expect(Math.min(...work.map((p) => p.x))).toBeLessThan(-0.6);
  expect(Math.max(...work.map((p) => p.x))).toBeGreaterThan(0.6);
  expect(work.filter((p) => p.y > 0).length / work.length).toBeGreaterThan(0.7); // mostly on the line, below centre
  const think = samples("thinking", 30);
  expect(think.filter((p) => p.y < -0.3).length / think.length).toBeGreaterThan(0.7); // mostly up
});

it("is the same for the same face and differs between faces, and stays in range", () => {
  expect(scanGaze("working", 12.34, 7)).toEqual(scanGaze("working", 12.34, 7));
  expect(scanGaze("working", 12.34, 7)).not.toEqual(scanGaze("working", 12.34, 8));
  for (const p of samples("thinking", 20).concat(samples("working", 20))) {
    expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
  }
});
