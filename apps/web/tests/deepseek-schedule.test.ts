import { describe, expect, it } from "vitest";
import { currentPeak, deepseekPhase, holidayOn, localWeek, nextScheduleChange, offPeakReason, peakWindows, scheduleCopy, shanghaiCivilDate, shortTime } from "@/lib/deepseek-schedule";

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

describe("deepseek schedule, as the owner sees it", () => {
  it("was off-peak through Golden Week: the first peak after it is Wednesday evening in US Eastern time", () => {
    // Oct 1-7 is a Chinese public holiday (and Oct 3-4 a weekend): nothing is peak until Thu Oct 8, 09:00 Beijing,
    // which is Wed Oct 7, 21:00 EDT. Seeing "Peak" only from Wednesday that week was right.
    const next = nextScheduleChange(new Date("2026-10-02T12:00:00Z"));
    expect(next?.toISOString()).toBe("2026-10-08T01:00:00.000Z");
    expect(holidayOn(new Date("2026-10-07T02:00:00Z"))).toBe("National Day (Golden Week)");
    expect(offPeakReason(new Date("2026-10-07T02:00:00Z"))).toBe("Chinese public holiday: National Day (Golden Week)");
  });

  it("lists the week's windows in order and says why it's off-peak", () => {
    const from = new Date("2026-10-09T12:00:00Z"); // Friday afternoon UTC
    const windows = peakWindows(from, 7).map((w) => [w.start.toISOString(), w.end.toISOString()]);
    expect(windows[0]).toEqual(["2026-10-12T01:00:00.000Z", "2026-10-12T04:00:00.000Z"]); // nothing over the weekend
    expect(windows).toHaveLength(10); // Mon-Fri, two windows each: next Friday morning is within 7 days of Friday noon
    expect(offPeakReason(new Date("2026-10-10T08:00:00Z"))).toBe("Weekend in China");
    expect(offPeakReason(new Date("2026-10-12T05:00:00Z"))).toBe("Outside DeepSeek's peak hours");
    expect(currentPeak(new Date("2026-10-12T02:00:00Z"))?.end.toISOString()).toBe("2026-10-12T04:00:00.000Z");
  });

  it("says peak costs double and until when; off-peak says why and when peak starts", () => {
    const peak = scheduleCopy(new Date("2026-10-12T02:00:00Z"), "match");
    expect(peak.phase).toBe("peak");
    expect(peak.detail).toMatch(/^Peak pricing: DeepSeek charges twice the off-peak rate until .+\. Matches DeepSeek's pricing page\.$/);
    const off = scheduleCopy(new Date("2026-10-03T02:00:00Z"));
    expect(off.detail).toMatch(/^Off-peak \(half price\)\. Chinese public holiday: National Day \(Golden Week\)\. Peak starts .+\.$/);
    expect(scheduleCopy(new Date("2027-01-04T02:00:00Z")).detail).toContain("dates on file are for 2026 only");
  });

  it("groups the windows by local day", () => {
    const week = localWeek(new Date("2026-10-11T12:00:00Z"));
    expect(week.length).toBeGreaterThanOrEqual(4);
    expect(week.flatMap((d) => d.windows)).toHaveLength(peakWindows(new Date("2026-10-11T12:00:00Z"), 7).length);
    expect(shortTime(new Date(2026, 9, 12, 21, 0))).not.toMatch(/:00/);
  });
});
