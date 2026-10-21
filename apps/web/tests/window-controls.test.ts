import { expect, it } from "vitest";

import { CAPTION_BUTTONS_PX, CAPTION_GAP_PX, controlsWidth } from "@/lib/window-controls";

/* The desktop app's window buttons (lib/window-controls.ts): headers keep clear of them whatever Chromium reports. */

const overlay = (x: number, width: number, visible = true) => ({
  visible,
  getTitlebarAreaRect: () => ({ x, width }) as DOMRect,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
});

it("uses the overlay's own measurement when it reports one, plus a little room", () => {
  // A wide window: the title bar area ends 180 px before the right edge.
  expect(controlsWidth(1400, overlay(0, 1220), true)).toBe(180 + CAPTION_GAP_PX);
});

it("never reserves less than the three caption buttons in the desktop app, even when Chromium reports nothing", () => {
  expect(controlsWidth(1400, overlay(0, 1400), true)).toBe(CAPTION_BUTTONS_PX + CAPTION_GAP_PX); // stale: no room reported
  expect(controlsWidth(900, null, true)).toBe(CAPTION_BUTTONS_PX + CAPTION_GAP_PX); // no overlay API at all
  expect(controlsWidth(900, overlay(0, 0, false), true)).toBe(CAPTION_BUTTONS_PX + CAPTION_GAP_PX);
});

it("a browser (no desktop app, no visible overlay) reserves nothing", () => {
  expect(controlsWidth(1400, null, false)).toBe(0);
  expect(controlsWidth(1400, overlay(0, 1400, false), false)).toBe(0);
});
