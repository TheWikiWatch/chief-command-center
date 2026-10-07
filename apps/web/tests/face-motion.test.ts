import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { facePose, MOOD_BLEND_S } from "@/components/bot-face";
import { botIdentity } from "@/lib/bot-identity";
import { headGaze, scanGaze } from "@/lib/eye-scan";

/**
 * Busy faces looked twitchy (2026-10-07): the head leaned and rolled with every 60 ms eye jump, a mood change popped
 * (and redrew the face at t = 0 for a frame), and the thought dots' clipped sine had a hard corner each cycle.
 */

const FRAME = 1 / 60;
const id = botIdentity({ id: "ivy", name: "Ivy" });

function maxStep(f: (t: number) => number, from: number, to: number) {
  let worst = 0;
  let prev = f(from);
  for (let t = from + FRAME; t < to; t += FRAME) {
    const v = f(t);
    worst = Math.max(worst, Math.abs(v - prev));
    prev = v;
  }
  return worst;
}

describe("a busy face's head follows its eyes smoothly", () => {
  for (const mood of ["thinking", "working"] as const) {
    it(`${mood}: the eyes still snap between holds, but the head never jumps`, () => {
      const eyes = maxStep((t) => scanGaze(mood, t, 7).x, 0, 30);
      const head = maxStep((t) => headGaze(mood, t, 7).x, 0, 30);
      expect(eyes).toBeGreaterThan(0.15); // a real saccade moves the eyes a lot in one frame
      // The head turns over a quarter second or more: never more than a third of the eyes' step, and a reading sweep
      // back across the whole line (1.5 units) is the fastest it gets.
      expect(head).toBeLessThan(eyes / 3);
      expect(head).toBeLessThan(0.1);
    });
  }

  for (const mood of ["thinking", "working"] as const) {
    it(`${mood}: the roll and lean a viewer sees move gently frame to frame`, () => {
      expect(maxStep((t) => facePose(mood, t, id).roll, 0, 30)).toBeLessThan(0.35); // degrees per frame
      expect(maxStep((t) => facePose(mood, t, id).tx, 0, 30)).toBeLessThan(0.08);
    });
  }

  it("the thought dots fade without corners", () => {
    for (let i = 0; i < 3; i++) expect(maxStep((t) => facePose("thinking", t, id).dots[i], 0, 20)).toBeLessThan(0.06);
  });
});

describe("a mood change glides", () => {
  it("starts exactly at the old mood's pose and ends at the new one's", () => {
    const t = 12.3;
    expect(facePose("thinking", t, id, 0, null, { from: "idle", k: 0 })).toEqual(facePose("idle", t, id));
    expect(facePose("thinking", t, id, 0, null, { from: "idle", k: 1 })).toEqual(facePose("thinking", t, id));
  });

  it("moves a little each frame across the blend instead of popping", () => {
    const at = 5;
    const k = (t: number) => {
      const u = Math.min(1, Math.max(0, (t - at) / MOOD_BLEND_S));
      return u * u * (3 - 2 * u);
    };
    const roll = (t: number) => facePose("thinking", t, id, 0, null, { from: "speaking", k: k(t) }).roll;
    const ty = (t: number) => facePose("thinking", t, id, 0, null, { from: "speaking", k: k(t) }).ty;
    expect(maxStep(roll, at, at + MOOD_BLEND_S)).toBeLessThan(0.6);
    expect(maxStep(ty, at, at + MOOD_BLEND_S)).toBeLessThan(0.12);
  });
});

describe("Chief's presence while thinking", () => {
  const css = readFileSync(path.join(__dirname, "..", "app", "globals.css"), "utf8");
  const rules = (selector: string) => css.split("}").filter((r) => r.includes(selector));

  it("breathes a glow, with no spinning ring and no orbiting dots", () => {
    expect(rules('[data-mood="thinking"] .pr-bloom').some((r) => r.includes("pr-breathe"))).toBe(true);
    for (const layer of [".pr-ring", ".pr-orbit"]) {
      const lit = rules(`[data-mood="thinking"] ${layer}`).concat(rules(`[data-mood="working"] ${layer}`));
      expect(lit.filter((r) => /opacity:\s*(0\.[1-9]|1)/.test(r))).toEqual([]);
    }
  });

  it("keeps the ring for the voice", () => {
    expect(rules('[data-mood="speaking"] .pr-ring').some((r) => /opacity:\s*0\.8/.test(r))).toBe(true);
  });
});
