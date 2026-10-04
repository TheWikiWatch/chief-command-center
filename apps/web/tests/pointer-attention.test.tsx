import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { BotFace, facePose, mouthMood } from "@/components/bot-face";
import { botIdentity } from "@/lib/bot-identity";
import { drawFaces, useFaceClock } from "@/lib/face-clock";
import { attentionWeight, lookState, setPointerForTest, stepLook, type Look } from "@/lib/pointer";

// A desktop with a mouse: the pointer store only listens where hover and a fine pointer exist.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({ matches: q.includes("pointer: fine"), media: q, addEventListener() {}, removeEventListener() {} }),
  });
});

let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  delete document.documentElement.dataset.ambient;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setPointerForTest(null);
});

const id = botIdentity({ id: "herb" });
const look = (over: Partial<Look>): Look => ({ x: 0, y: 0, w: 0, hover: false, hoverFor: Infinity, blink: 0, ...over });

it("attention is near times recent, and always lets go of a parked cursor", () => {
  expect(attentionWeight(60, 0.2, 72)).toBeGreaterThan(0.95);
  expect(attentionWeight(600, 0.2, 72)).toBe(0);
  expect(attentionWeight(60, 3, 72)).toBe(0);
  const mid = attentionWeight(200, 0.2, 72);
  expect(mid).toBeGreaterThan(0.05);
  expect(mid).toBeLessThan(0.95);
  expect(attentionWeight(60, 1.8, 72)).toBeLessThan(attentionWeight(60, 0.5, 72));
});

it("stepLook eases toward the cursor, notices hover, and blinks on a long jump", () => {
  const s = lookState();
  s.box = { cx: 100, cy: 100, size: 72 };
  setPointerForTest({ x: 260, y: 100 });
  let t = 0;
  for (let i = 0; i < 40; i++) stepLook(s, (t += 0.016));
  expect(s.w).toBeGreaterThan(0.3);
  expect(s.x).toBeGreaterThan(0.5);
  expect(s.hover).toBe(false);
  // Jump to the far side: a big gaze shift brings a blink with it.
  setPointerForTest({ x: -60, y: 100 });
  stepLook(s, (t += 0.016));
  expect(s.blink).toBeGreaterThan(0);
  setPointerForTest({ x: 110, y: 95 });
  stepLook(s, (t += 0.016));
  expect(s.hover).toBe(true);
  expect(s.hoverFor).toBe(0);
});

it("moods decide how much the cursor pulls: idle follows, working only glances, asleep ignores", () => {
  const toward = look({ x: 1, y: 0, w: 1 });
  // How much of the way toward the cursor the eyes go (busy eyes may start anywhere along their scan).
  const share = (mood: "idle" | "working") => {
    const plain = facePose(mood, 2, id, 0).gazeX;
    return (facePose(mood, 2, id, 0, toward).gazeX - plain) / (5.2 - plain);
  };
  const idle = share("idle");
  const working = share("working");
  expect(idle).toBeGreaterThan(working);
  expect(working).toBeGreaterThan(0);
  expect(facePose("asleep", 2, id, 0, toward)).toEqual(facePose("asleep", 2, id, 0));
});

it("hover: looks straight at you, eyes widen, a small hop, and a hello smile", () => {
  const plain = facePose("idle", 2, id, 0);
  const hovered = facePose("idle", 2, id, 0, look({ x: 0.8, w: 1, hover: true, hoverFor: 0.16 }));
  expect(hovered.gazeX).toBeCloseTo(0, 5);
  expect(hovered.eyeScale).toBeGreaterThan(1.1);
  expect(hovered.ty).toBeLessThan(plain.ty - 1);
  expect(mouthMood("idle", look({ hover: true, hoverFor: 0.2 }))).toBe("notice");
  expect(mouthMood("speaking", look({ hover: true, hoverFor: 0.2 }))).toBe("speaking");
  expect(mouthMood("failed", look({ hover: true, hoverFor: 0.2 }))).toBe("failed");
});

it("a sleeping bot flutters its eyes open on hover, then goes back to sleep", () => {
  const asleep = facePose("asleep", 2, id, 0);
  const flutter = facePose("asleep", 2, id, 0, look({ hover: true, hoverFor: 0.55 }));
  const after = facePose("asleep", 2, id, 0, look({ hover: true, hoverFor: 1.5 }));
  expect(flutter.lid).toBeGreaterThan(asleep.lid + 1);
  expect(after.lid).toBe(asleep.lid);
});

it("the face clock measures every face before it writes any", () => {
  const order: string[] = [];
  function Probe({ name }: { name: string }) {
    const ref = { current: document.body };
    useFaceClock(ref, () => void order.push(`draw ${name}`), true, () => void order.push(`measure ${name}`));
    return null;
  }
  render(
    <>
      <Probe name="a" />
      <Probe name="b" />
    </>,
  );
  order.length = 0;
  drawFaces(1);
  expect(order).toEqual(["measure a", "measure b", "draw a", "draw b"]);
});

it("a real face turns its eyes toward a nearby cursor and widens them on hover", () => {
  render(<BotFace name="Herb" profileId="herb" shape="circle" size={72} />);
  const svg = document.querySelector("svg")!;
  svg.getBoundingClientRect = () => ({ left: 100, top: 100, width: 72, height: 72, right: 172, bottom: 172, x: 100, y: 100, toJSON() {} }) as DOMRect;
  const eye = svg.querySelector("ellipse")!;
  let t = 1;
  const run = (n: number) => {
    for (let i = 0; i < n; i++) drawFaces((t += 0.016));
  };
  setPointerForTest({ x: 136, y: 136 - 300 });
  act(() => run(2));
  setPointerForTest({ x: 136 + 180, y: 136 });
  act(() => run(60));
  const cxFollowing = Number(eye.getAttribute("cx"));
  expect(cxFollowing).toBeGreaterThan(15.4 + 0.4);
  setPointerForTest({ x: 136, y: 136 });
  act(() => run(12));
  expect(Number(eye.getAttribute("rx"))).toBeGreaterThan(2.3);
});

it("ambience Off turns the cursor reactions off", () => {
  document.documentElement.dataset.ambient = "off";
  render(<BotFace name="Herb" profileId="herb" shape="circle" size={72} />);
  const svg = document.querySelector("svg")!;
  svg.getBoundingClientRect = () => ({ left: 100, top: 100, width: 72, height: 72, right: 172, bottom: 172, x: 100, y: 100, toJSON() {} }) as DOMRect;
  setPointerForTest({ x: 136, y: 136 });
  act(() => {
    for (let i = 0; i < 12; i++) drawFaces(1 + i * 0.016);
  });
  expect(Number(svg.querySelector("ellipse")!.getAttribute("rx"))).toBeCloseTo(2.2, 5);
});
