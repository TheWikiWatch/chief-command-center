import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { fx } from "@/lib/fx";
import { updateFx } from "@/lib/fx-prefs";

const vibrate = vi.fn(() => true);
beforeEach(() => {
  localStorage.clear();
  vibrate.mockClear();
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
});
afterEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

it("vibrates each event with its own pattern when its switch is on", () => {
  expect(fx("send").haptic).toBe(true);
  expect(vibrate).toHaveBeenLastCalledWith(12);
  fx("approval");
  expect(vibrate).toHaveBeenLastCalledWith([20, 60, 20, 60, 40]);
  fx("fleet", "minted");
  expect(vibrate).toHaveBeenLastCalledWith([10, 30, 20]);
  fx("connection", "back");
  expect(vibrate).toHaveBeenLastCalledWith([10, 30, 10]);
});

it("respects the per-event switch, the master switch and the default-off tap", () => {
  expect(fx("tap").haptic).toBe(false);
  updateFx((p) => ({ ...p, haptics: { ...p.haptics, reply: false } }));
  expect(fx("reply").haptic).toBe(false);
  expect(fx("send").haptic).toBe(true);
  updateFx((p) => ({ ...p, haptics: { ...p.haptics, master: false } }));
  expect(fx("send").haptic).toBe(false);
  expect(vibrate).toHaveBeenCalledTimes(1);
});

it("stays silent while the app is hidden", () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  expect(fx("approval")).toEqual({ sound: false, haptic: false });
  expect(vibrate).not.toHaveBeenCalled();
});
