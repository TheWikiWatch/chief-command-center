import { describe, expect, it } from "vitest";

import type { NousPlan, PlanGauge } from "@/lib/fleet-client";
import { blocks, featuredFirst, limitLine, resetsIn, sizeWord, spentFor } from "@/lib/plan-usage";

const NOW = 1_800_000_000;
const gauge = (over: Partial<PlanGauge>): PlanGauge => ({ label: "day", title: "", used: 10, full: false, resetsAt: NOW + 3600, scope: "all", ...over });
const plan = (over: Partial<NousPlan> = {}): NousPlan => ({
  name: "Plus",
  gauges: [gauge({})],
  paused: null,
  creditsPay: null,
  featured: [],
  large: ["big"],
  free: ["gratis"],
  ...over,
});

// The rules of Hermes's own pickers (hermes_cli/model_picker_usage.py): `blocks`, `exhausted_gauge`, `limit_line`.
describe("a Nous plan with usage windows", () => {
  it("a full allowance stops the models it covers, never a Free one, and not when credits pay", () => {
    const weekFull = plan({ gauges: [gauge({}), gauge({ label: "week", used: 100, full: true, resetsAt: NOW + 7200 })] });
    expect(blocks(weekFull, "small")).toBe(true);
    expect(blocks(weekFull, "big")).toBe(true);
    expect(blocks(weekFull, "gratis")).toBe(false);
    expect(blocks(weekFull, "any:free")).toBe(false);
    expect(blocks({ ...weekFull, creditsPay: true }, "small")).toBe(false);
    const largeFull = plan({ gauges: [gauge({ label: "top_tier", scope: "large", used: 100, full: true })] });
    expect(blocks(largeFull, "big")).toBe(true);
    expect(blocks(largeFull, "small")).toBe(false);
  });

  it("of several full allowances, the one that refills last is the one that counts", () => {
    const both = plan({
      gauges: [gauge({ label: "day", used: 100, full: true, resetsAt: NOW + 100 }), gauge({ label: "week", used: 100, full: true, resetsAt: NOW + 900 })],
    });
    expect(spentFor(both, "small")?.label).toBe("week");
  });

  it("says what a full allowance means, in the plan's terms", () => {
    const week = gauge({ label: "week", used: 100, full: true, resetsAt: NOW + 21 * 3600 });
    expect(limitLine(plan({ gauges: [week] }), NOW)).toBe("Weekly limit reached · resets in 21h");
    expect(limitLine(plan({ gauges: [week], creditsPay: false }), NOW)).toBe("Weekly limit reached · resets in 21h · only Free models until then");
    expect(limitLine(plan({ gauges: [week], creditsPay: true }), NOW)).toBe("Weekly limit reached · resets in 21h · paid models now use your credits");
    const large = gauge({ label: "top_tier", scope: "large", used: 100, full: true, resetsAt: NOW + 3 * 86_400 });
    expect(limitLine(plan({ gauges: [large], creditsPay: false }), NOW)).toBe("Large-model limit reached · resets in 3d · Large models paused until then");
    expect(limitLine(plan(), NOW)).toBeNull();
    expect(limitLine(plan({ gauges: [week], paused: "billing" }), NOW)).toBeNull(); // a pause is said on its own
  });

  it("names sizes, lists the plan's picks first, and counts down", () => {
    expect([sizeWord(plan(), "big"), sizeWord(plan(), "gratis"), sizeWord(plan(), "small")]).toEqual(["Large", "Free", ""]);
    expect(featuredFirst(plan({ featured: ["c", "missing"] }), ["a", "b", "c"])).toEqual(["c", "a", "b"]);
    expect(featuredFirst(null, ["a", "b"])).toEqual(["a", "b"]);
    expect([resetsIn(NOW + 59, NOW), resetsIn(NOW + 1200, NOW), resetsIn(NOW + 5 * 3600, NOW), resetsIn(NOW - 5, NOW)]).toEqual(["soon", "in 20m", "in 5h", "soon"]);
  });
});
