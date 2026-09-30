import { describe, expect, it, beforeEach } from "vitest";
import { COMPACT_KEY, FONT_KEY, FONT_STEPS, STAY_KEY } from "@/lib/dashboard-prefs";

describe("dashboard prefs keys", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("exports stable storage keys", () => {
    expect(FONT_KEY).toBe("chief-chat-font");
    expect(COMPACT_KEY).toBe("chief-chat-compact");
    expect(STAY_KEY).toBe("chief-stay-awake");
    expect(FONT_STEPS).toContain(14);
  });

  it("round-trips compact flag like the hook", () => {
    localStorage.setItem(COMPACT_KEY, "1");
    expect(localStorage.getItem(COMPACT_KEY) === "1").toBe(true);
    localStorage.setItem(COMPACT_KEY, "0");
    expect(localStorage.getItem(COMPACT_KEY) === "1").toBe(false);
  });
});
