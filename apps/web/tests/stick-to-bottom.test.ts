import { expect, it } from "vitest";

import { IDLE_MS, StickState } from "@/lib/stick-to-bottom";

// A 2000px thread in a 600px window: the bottom is scrollTop 1400.
const H = 2000;
const C = 600;

it("follows new messages while you are at the bottom", () => {
  const s = new StickState();
  s.scroll(1400, H, C, 0);
  expect(s.follow("incoming", 10)).toBe(true);
});

it("stays put while you scroll up to read, then catches up after 8s idle", () => {
  const s = new StickState();
  s.scroll(1400, H, C, 0);
  s.gesture(1000);
  s.scroll(900, H, C, 1050);
  expect(s.pinned).toBe(false);
  expect(s.follow("incoming", 3000)).toBe(false);
  expect(s.follow("grow", 3000)).toBe(false);
  // Momentum keeps scrolling after the finger lifts: still reading.
  s.scroll(700, H, C, 4000);
  expect(s.follow("incoming", 4000 + IDLE_MS - 1)).toBe(false);
  expect(s.follow("incoming", 4000 + IDLE_MS)).toBe(true);
  expect(s.pinned).toBe(true);
});

it("a tap as a reply lands never unpins: the app only scrolls down", () => {
  const s = new StickState();
  s.scroll(1400, H, C, 0);
  s.gesture(100);
  // Reply arrives: content grows by 500px, then the smooth scroll moves down through far-from-bottom positions.
  s.scroll(1500, H + 500, C, 150);
  s.scroll(1700, H + 500, C, 200);
  expect(s.pinned).toBe(true);
  expect(s.follow("incoming", 300)).toBe(true);
});

it("an upward scroll with no gesture (content shrinking) does not unpin", () => {
  const s = new StickState();
  s.scroll(1400, H, C, 0);
  s.scroll(1000, H, C, 50_000);
  expect(s.pinned).toBe(true);
});

it("your own send always scrolls down, and coming back to the tab follows the idle rule", () => {
  const s = new StickState();
  s.gesture(0);
  s.scroll(200, H, C, 10);
  expect(s.follow("mine", 20)).toBe(true);
  s.gesture(100);
  s.scroll(100, H, C, 120);
  expect(s.follow("shown", 2000)).toBe(false);
  expect(s.follow("shown", 120 + IDLE_MS)).toBe(true);
});
