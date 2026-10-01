import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

const lookAt = vi.fn();
vi.mock("@blobatar/react/gaze", () => ({ useGaze: () => ({ ref: () => undefined, lookAt, remeasure: () => undefined }) }));

import { drawFaces } from "@/lib/face-clock";
import { setPointerForTest } from "@/lib/pointer";
import { useAttentiveGaze } from "@/lib/use-attentive-gaze";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({ matches: q.includes("pointer: fine"), media: q, addEventListener() {}, removeEventListener() {} }),
  });
});
afterEach(() => {
  cleanup();
  setPointerForTest(null);
  lookAt.mockClear();
});

const task = { current: null as HTMLElement | null };

function Nova() {
  const { ref } = useAttentiveGaze(() => task.current);
  return (
    <svg
      ref={(el) => {
        if (el) el.getBoundingClientRect = () => ({ left: 400, top: 400, width: 100, height: 100, right: 500, bottom: 500, x: 400, y: 400, toJSON() {} }) as DOMRect;
        ref(el);
      }}
    />
  );
}

const last = () => lookAt.mock.calls.at(-1)?.[0];

it("idle: his own glances (null); near cursor: follows it; parked cursor: lets go", () => {
  render(<Nova />);
  drawFaces(1);
  expect(last()).toBeNull();
  setPointerForTest({ x: 620, y: 450 });
  drawFaces(1.1);
  expect(last()).toEqual({ x: 620, y: 450 });
  setPointerForTest({ x: 620, y: 450, idle: 3 });
  drawFaces(1.2);
  expect(last()).toBeNull();
});

it("a working bot beats the cursor, and hovering Nova beats both", () => {
  task.current = document.createElement("div");
  render(<Nova />);
  setPointerForTest({ x: 620, y: 450 });
  drawFaces(1);
  expect(last()).toBe(task.current);
  setPointerForTest({ x: 450, y: 450 });
  drawFaces(1.1);
  expect(last()).toBe("rest");
  task.current = null;
});

it("the eyes do not flap at the edge of attention (hysteresis)", () => {
  render(<Nova />);
  // 275px out is too far to catch his eye from idle...
  setPointerForTest({ x: 450 + 275, y: 450 });
  drawFaces(1);
  expect(last()).toBeNull();
  // ...but once he is watching from closer, drifting out to 275px keeps his attention.
  setPointerForTest({ x: 450 + 180, y: 450 });
  drawFaces(1.1);
  expect(last()).toEqual({ x: 630, y: 450 });
  setPointerForTest({ x: 450 + 275, y: 450 });
  drawFaces(1.2);
  expect(last()).toEqual({ x: 725, y: 450 });
});
