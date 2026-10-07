import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BotFace, bubbleParts, usableLook } from "@/components/bot-face";
import { BUBBLE_BODIES, BUBBLE_EYES, bodyBox, bodyPath, bodyPoints, bubblePaint, eyePath, faceLayout, floatHeight, squash, strokedEyes } from "@/lib/bubble";

afterEach(cleanup);

describe("the Bubble face's geometry", () => {
  it("draws every body as one closed, smooth outline inside the face box, resting on the same ground", () => {
    for (const body of BUBBLE_BODIES) {
      const d = bodyPath(body);
      expect(d.startsWith("M")).toBe(true);
      expect(d.endsWith("Z")).toBe(true);
      expect(d.match(/C/g)?.length).toBe(bodyPoints(body).length);
      const box = bodyBox(body);
      expect(box.left).toBeGreaterThan(1);
      expect(box.right).toBeLessThan(39);
      expect(box.top).toBeGreaterThan(1);
      expect(box.bottom).toBeGreaterThan(35); // every body sits near the ground line…
      expect(box.bottom).toBeLessThan(39.5); // …and none sinks through its shadow
    }
  });

  it("puts the eyes, cheeks and mouth inside each body, the mouth below the eyes", () => {
    for (const body of BUBBLE_BODIES) {
      const box = bodyBox(body);
      const f = faceLayout(body);
      for (const [x, y] of [f.eyeL, f.eyeR, f.cheekL, f.cheekR, f.mouth]) {
        expect(x).toBeGreaterThan(box.left + 2);
        expect(x).toBeLessThan(box.right - 2);
        expect(y).toBeGreaterThan(box.top + 2);
        expect(y).toBeLessThan(box.bottom - 2);
      }
      expect(f.mouth[1]).toBeGreaterThan(f.eyeL[1]);
      expect(f.eyeR[0] - f.eyeL[0]).toBeGreaterThan(5);
    }
  });

  it("draws every eye style open and blinking; line eyes are stroked", () => {
    for (const eyes of BUBBLE_EYES) {
      expect(eyePath(eyes, 2.3)).toMatch(/^M/);
      expect(eyePath(eyes, 0.35)).toMatch(/^M/);
    }
    expect(BUBBLE_EYES.filter(strokedEyes)).toEqual(["happy", "sleepy"]);
    // A blink is visibly shorter than an open eye (the dot's vertical radius).
    const ry = (d: string) => Number(/A[\d.]+ ([\d.]+)/.exec(d)![1]);
    expect(ry(eyePath("dot", 0.35))).toBeLessThan(ry(eyePath("dot", 2.3)) / 3);
  });

  it("squashes as a happy hop lands, stretches with speech, and floats highest mid-hop", () => {
    expect(squash("celebrating", 0, 0, 0)).toBeGreaterThan(0.1); // on the ground
    expect(squash("celebrating", Math.PI / 12, 0, 0)).toBeLessThan(0); // in the air
    expect(squash("speaking", 0, 0, 1)).toBeLessThan(0);
    expect(floatHeight("celebrating", Math.PI / 12, 0)).toBeGreaterThan(floatHeight("celebrating", 0, 0));
    expect(floatHeight("asleep", 3, 1)).toBeLessThan(0.5);
  });

  it("paints from one colour, and an older non-hex colour falls back to a palette one", () => {
    const p = bubblePaint("#E5484D");
    expect(p.base).toBe("#e5484d");
    expect(p.light).not.toBe(p.base);
    expect(p.shade).not.toBe(p.base);
    expect(bubblePaint("hsl(0 68% 58%)").base).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("choosing a face from a saved look", () => {
  it("draws a bubble for a bubble look, with its chosen parts, and a stable pick when parts are missing", () => {
    const { container } = render(<BotFace name="Ivy" profileId="ivy" look={{ style: "bubble", color: "#00c9bf", body: "drop", eyes: "happy", cheeks: true }} size={64} still />);
    expect(container.querySelector('radialGradient[id$="-ao"]')).toBeTruthy();
    expect(container.querySelectorAll("ellipse[rx='2.3']").length).toBe(2); // the cheeks
    expect(bubbleParts({ style: "bubble" }, "ivy")).toEqual(bubbleParts({ style: "bubble" }, "ivy"));
    expect(bubbleParts({ style: "bubble", body: "nonsense", eyes: "nope" }, "ivy").eyes).toBe("dot");
  });

  it("a malformed look is ignored and the bot keeps its default face", () => {
    expect(usableLook({ style: "sparkles" } as never)).toBeNull();
    expect(usableLook(null)).toBeNull();
    const { container } = render(<BotFace name="Ivy" profileId="ivy" look={{ style: "sparkles" } as never} size={64} still />);
    expect(container.querySelector('radialGradient[id$="-ao"]')).toBeNull();
    expect(container.querySelector("svg, img, div")).toBeTruthy();
  });

  it("a shape look draws that geometric face", () => {
    const { container } = render(<BotFace name="Sq" profileId="sq" look={{ style: "shape", color: "#f69769", shape: "hexagon" }} size={64} still />);
    expect(container.querySelector('path[d^="M20 3.5 L34.5 11.75"]')).toBeTruthy();
  });
});
