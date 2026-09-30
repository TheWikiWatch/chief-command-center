import { describe, expect, it } from "vitest";
import { deepseekPhase, nextScheduleChange, shanghaiCivilDate } from "@/lib/deepseek-schedule";

describe("deepseek schedule", () => {
  it("is off-peak on a weekday afternoon in US Eastern time", () => {
    expect(deepseekPhase(new Date("2026-09-21T20:00:00Z"))).toBe("off-peak");
  });

  it("uses the two UTC peak windows and the gap between them", () => {
    expect(deepseekPhase(new Date("2026-09-21T02:30:00Z"))).toBe("peak");
    expect(deepseekPhase(new Date("2026-09-21T05:00:00Z"))).toBe("off-peak");
    expect(deepseekPhase(new Date("2026-09-21T08:00:00Z"))).toBe("peak");
    expect(deepseekPhase(new Date("2026-09-21T01:00:00Z"))).toBe("peak");
    expect(deepseekPhase(new Date("2026-09-21T04:00:00Z"))).toBe("off-peak");
    expect(deepseekPhase(new Date("2026-09-21T10:00:00Z"))).toBe("off-peak");
  });

  it("treats weekends as off-peak even inside the clock windows", () => {
    expect(deepseekPhase(new Date("2026-09-26T02:00:00Z"))).toBe("off-peak");
  });

  it("treats Chinese public holidays as off-peak for the Shanghai day", () => {
    expect(shanghaiCivilDate(new Date("2026-09-25T02:00:00Z"))).toBe("2026-09-25");
    expect(deepseekPhase(new Date("2026-09-25T02:00:00Z"))).toBe("off-peak");
    expect(deepseekPhase(new Date("2026-10-01T08:00:00Z"))).toBe("off-peak");
  });

  it("names the next boundary", () => {
    const next = nextScheduleChange(new Date("2026-09-21T20:30:00Z"));
    expect(next?.toISOString()).toBe("2026-09-22T01:00:00.000Z");
    const end = nextScheduleChange(new Date("2026-09-21T02:30:00Z"));
    expect(end?.toISOString()).toBe("2026-09-21T04:00:00.000Z");
  });
});
