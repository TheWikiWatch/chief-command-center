import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FX, FX_EVENTS, FX_KEY, fxEnabled, parseFx, readFx, updateFx } from "@/lib/fx-prefs";

describe("fx prefs", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to every sound and haptic on except button taps", () => {
    const prefs = readFx();
    expect(prefs).toEqual(DEFAULT_FX);
    for (const event of FX_EVENTS) {
      expect(fxEnabled("sound", event, prefs)).toBe(event !== "tap");
      expect(fxEnabled("haptics", event, prefs)).toBe(event !== "tap");
    }
  });

  it("gates each event separately and under the master switch", () => {
    updateFx((p) => ({ ...p, sound: { ...p.sound, reply: false } }));
    expect(fxEnabled("sound", "reply")).toBe(false);
    expect(fxEnabled("sound", "send")).toBe(true);
    expect(fxEnabled("haptics", "reply")).toBe(true);
    updateFx((p) => ({ ...p, haptics: { ...p.haptics, master: false } }));
    expect(fxEnabled("haptics", "send")).toBe(false);
    expect(fxEnabled("sound", "send")).toBe(true);
  });

  it("survives corrupt or partial storage and clamps values", () => {
    expect(parseFx("not json")).toEqual(DEFAULT_FX);
    const partial = parseFx(JSON.stringify({ motion: "sideways", volume: 7, sound: { send: false, bogus: true }, uiScale: "large" }));
    expect(partial.motion).toBe("system");
    expect(partial.volume).toBe(1);
    expect(partial.sound.send).toBe(false);
    expect(partial.sound.reply).toBe(true);
    expect(partial.uiScale).toBe("large");
  });

  it("returns a stable snapshot until storage changes", () => {
    const a = readFx();
    expect(readFx()).toBe(a);
    localStorage.setItem(FX_KEY, JSON.stringify({ ambient: "low" }));
    const b = readFx();
    expect(b).not.toBe(a);
    expect(b.ambient).toBe("low");
  });
});
