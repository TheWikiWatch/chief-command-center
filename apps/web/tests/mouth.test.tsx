import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { BotFace, blobMouthFrame } from "@/components/bot-face";
import { botIdentity } from "@/lib/bot-identity";
import { CLOSED, fakeVoice, mouthPath, mouthTarget, stepMouth, voiceFromBands, type MouthMood } from "@/lib/mouth";

let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function runFrames(n: number) {
  for (let i = 0; i < n; i++) {
    const batch = frames;
    frames = [];
    for (const cb of batch) cb(performance.now() + i * 16);
  }
}

const id = botIdentity({ id: "ada" });
const MOODS: MouthMood[] = ["idle", "working", "failed", "thinking", "listening", "speaking", "waiting", "asleep", "celebrating", "notice"];
const settle = (mood: MouthMood, voice = null as ReturnType<typeof fakeVoice> | null) => {
  let m = CLOSED;
  for (let i = 0; i < 80; i++) m = stepMouth(m, mouthTarget(mood, 3, id, voice), 0.05, mood === "speaking");
  return m;
};

it("every mood gives a finite shape, and the moods read the way they should", () => {
  for (const mood of MOODS) {
    for (let t = 0; t < 12; t += 0.37) {
      const m = mouthTarget(mood, t, id, null, 0.5);
      for (const v of Object.values(m)) expect(Number.isFinite(v)).toBe(true);
    }
  }
  expect(settle("idle").c).toBeGreaterThan(0.3);
  expect(settle("failed").c).toBeLessThan(-0.5);
  expect(settle("waiting").r).toBeGreaterThan(0.9);
  expect(settle("waiting").o).toBeGreaterThan(0.5);
  expect(settle("celebrating").o).toBeGreaterThan(0.4);
  expect(settle("working").o).toBe(0);
});

it("the path always has the same commands, so any shape morphs into any other", () => {
  const shape = (d: string) => d.replace(/[-\d.\s]+/g, "");
  const reference = shape(mouthPath(CLOSED, 20, 25, 3));
  expect(reference).toBe("MCCZ");
  for (const mood of MOODS) expect(shape(mouthPath(settle(mood), 20, 25, 3))).toBe(reference);
});

it("speech opens fast and closes slower (an asymmetric envelope)", () => {
  const open = { ...CLOSED, o: 1 };
  const opening = stepMouth(CLOSED, open, 0.03, true).o;
  const closing = 1 - stepMouth(open, CLOSED, 0.03, true).o;
  expect(opening).toBeGreaterThan(closing * 1.8);
});

it("band balance picks the lip shape: low is round, bright is wide, sibilant is a slit", () => {
  const round = voiceFromBands(0.6, { low: 0.9, mid: 0.2, high: 0.05, sib: 0.02 });
  const wide = voiceFromBands(0.6, { low: 0.15, mid: 0.8, high: 0.7, sib: 0.1 });
  const hiss = voiceFromBands(0.2, { low: 0.05, mid: 0.1, high: 0.3, sib: 0.9 });
  expect(round.round).toBeGreaterThan(round.wide);
  expect(wide.wide).toBeGreaterThan(wide.round);
  expect(hiss.hiss).toBeGreaterThan(0.5);
  const rounded = settle("speaking", round);
  const spread = settle("speaking", wide);
  expect(rounded.r).toBeGreaterThan(spread.r);
  expect(spread.w).toBeGreaterThan(rounded.w);
  expect(settle("speaking", hiss).o).toBeLessThan(settle("speaking", wide).o);
});

it("the fake voice moves the mouth in syllables, not a fixed flap", () => {
  const levels = Array.from({ length: 200 }, (_, i) => fakeVoice(i * 0.016).level);
  expect(Math.max(...levels)).toBeGreaterThan(0.5);
  expect(Math.min(...levels)).toBeLessThan(0.1);
});

it("Blobatar layout contract: Chief's mouth lands under his eyes, inside his face", () => {
  const frame = blobMouthFrame("chief", 0.9325);
  expect(frame).not.toBeNull();
  const f = frame!;
  expect(f.cx).toBeGreaterThan(40);
  expect(f.cx).toBeLessThan(60);
  expect(f.cy).toBeGreaterThan(58);
  expect(f.cy).toBeLessThan(80);
  expect(f.W).toBeGreaterThan(3);
  expect(f.W).toBeLessThan(12);
  expect(f.color).toMatch(/^#[0-9a-f]{6}$/i);
});

it("Chief's animated blob wears the mouth inside its bob group, and gets it back after an expression change", () => {
  const view = render(<BotFace name="Chief" profileId="chief" shape="blobatar::hexagon" isChief custom size={100} mood="idle" />);
  act(() => runFrames(3));
  const mouth = () => document.querySelector(".mo-bob > path.bf-mouth");
  expect(mouth()).not.toBeNull();
  expect(mouth()!.getAttribute("d")).toMatch(/^M.*C.*C.*Z$/);
  // "failed" swaps in the sad expression, which re-renders the Blobatar's markup.
  view.rerender(<BotFace name="Chief" profileId="chief" shape="blobatar::hexagon" isChief custom size={100} mood="failed" />);
  act(() => runFrames(3));
  expect(document.querySelectorAll(".bf-mouth")).toHaveLength(1);
  expect(mouth()).not.toBeNull();
});

it("a still blob draws its mouth as an overlay, and tiny faces have none", () => {
  render(<BotFace name="Chief" profileId="chief" shape="blobatar::hexagon" isChief custom size={48} mood="idle" still />);
  expect(document.querySelector("img")).not.toBeNull();
  expect(document.querySelector("svg path[stroke-linejoin=round]")).not.toBeNull();
  cleanup();
  render(<BotFace name="Ada" profileId="ada" shape="circle" size={16} still />);
  expect(document.querySelectorAll("svg path[stroke-linejoin=round]")).toHaveLength(0);
});
