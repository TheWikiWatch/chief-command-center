import { act, cleanup, render } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { BotFace, facePose } from "@/components/bot-face";
import { botIdentity, BOT_PALETTE } from "@/lib/bot-identity";
import { faceCount } from "@/lib/face-clock";

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

it("animates faces without a single React commit per frame", () => {
  let commits = 0;
  render(
    <Profiler id="faces" onRender={() => commits++}>
      {["ada", "cody", "freddie", "herb"].map((id) => (
        <BotFace key={id} name={id} profileId={id} shape="triangle" size={48} ring="working" />
      ))}
    </Profiler>,
  );
  const afterMount = commits;
  const body = document.querySelector("svg g") as SVGGElement;
  const before = body.getAttribute("transform");
  act(() => runFrames(90));
  expect(commits).toBe(afterMount);
  expect(body.getAttribute("transform")).not.toBe(before);
});

it("registers and unregisters faces as bots come and go (no leaks)", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `bot-${i}`);
  const view = render(<>{ids(3).map((id) => <BotFace key={id} name={id} profileId={id} size={32} />)}</>);
  expect(faceCount()).toBe(3);
  view.rerender(<>{ids(9).map((id) => <BotFace key={id} name={id} profileId={id} size={32} />)}</>);
  expect(faceCount()).toBe(9);
  view.rerender(<>{ids(2).map((id) => <BotFace key={id} name={id} profileId={id} size={32} />)}</>);
  expect(faceCount()).toBe(2);
  view.rerender(<>{ids(2).map((id) => <BotFace key={id} name={id} profileId={id} size={32} still />)}</>);
  expect(faceCount()).toBe(0);
  view.unmount();
  expect(faceCount()).toBe(0);
});

it("gives any new bot a stable identity with zero setup", () => {
  const a = botIdentity({ id: "ivy-research", name: "Ivy" });
  const b = botIdentity({ id: "ivy-research", name: "Ivy - Research Assistant" });
  expect(a).toEqual(b);
  expect(BOT_PALETTE).toContain(a.color);
  expect(botIdentity({ id: "x", shape: "not-a-shape" }).shape).not.toBe("not-a-shape");
  expect(botIdentity({ id: "x", color: "#123456", custom: true }).color).toBe("#123456");
  expect(botIdentity({ id: "chief", color: "#7adbd4", isChief: true }).color).toBe("#7adbd4");
});

it("every mood produces a finite pose", () => {
  const id = botIdentity({ id: "chief" });
  for (const mood of ["idle", "working", "failed", "thinking", "listening", "speaking", "waiting", "asleep", "celebrating"] as const) {
    for (const t of [0, 1.3, 7.7]) {
      const pose = facePose(mood, t, id, 0.5);
      for (const v of [pose.tx, pose.ty, pose.roll, pose.scale, pose.gazeX, pose.gazeY, pose.lid, pose.zz, ...pose.dots]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  }
});
