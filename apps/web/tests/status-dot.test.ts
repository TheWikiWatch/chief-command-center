import { afterEach, describe, expect, it, vi } from "vitest";

import { HELD_MS, RESUME_GRACE_MS, staleWindow, summarizeHealth, type HealthEntry } from "@/lib/health-store";
import { poll } from "@/lib/poll";

// A tester saw the phone's dot turn yellow ("Chat stale 45s") almost every time they opened the app, with nothing
// wrong: the long-poll left open in the background was dead, and the app waited out its timeout.

afterEach(() => {
  vi.useRealTimers();
  delete (document as unknown as Record<string, unknown>).visibilityState;
});

const chat = (over: Partial<HealthEntry>): HealthEntry => ({ label: "Chat", updatedAt: 0, error: null, staleAfter: 40_000, ...over });

describe("the connection dot", () => {
  const t = 1_000_000;

  it("counts an open long-poll as connected, and a quiet one with no request as stale", () => {
    expect(summarizeHealth([chat({ updatedAt: t - 50_000, pendingSince: t - 20_000 })], t, 0, 0).state).toBe("ok");
    expect(summarizeHealth([chat({ updatedAt: t - 50_000, pendingSince: null })], t, 0, 0).state).toBe("degraded");
    // A request hanging longer than the window is no longer proof of anything.
    expect(summarizeHealth([chat({ updatedAt: t - 90_000, pendingSince: t - 45_000 })], t, 0, 0).state).toBe("degraded");
  });

  it("gives the app a moment after coming back before calling anything stale", () => {
    const quiet = [chat({ updatedAt: t - 120_000 })];
    expect(summarizeHealth(quiet, t, 0, t - 5_000).state).toBe("ok");
    expect(summarizeHealth(quiet, t, 0, t - RESUME_GRACE_MS - 1).state).toBe("ok"); // counted from the return, not before it
    expect(summarizeHealth(quiet, t + 40_000, 0, t - RESUME_GRACE_MS - 1).state).toBe("degraded");
  });

  it("takes two failures in a row to call it an error", () => {
    expect(summarizeHealth([chat({ updatedAt: t - 1_000, error: "dropped", failures: 1 })], t, 0, 0).state).toBe("ok");
    const two = summarizeHealth([chat({ updatedAt: t - 1_000, error: "dropped", failures: 2 })], t, 0, 0);
    expect(two.state).toBe("degraded");
    expect(two.worst?.label).toBe("Chat");
  });

  // The owner saw "Chat error" under the chief for minutes with nothing wrong, and sending a message fixed it: two
  // quick failures (the PC locking) left an error that only a reply cleared, while a healthy long-poll waited 25 s.
  it("lets a request the bridge is holding outrank earlier failures", () => {
    const failed = { updatedAt: t - 60_000, error: "dropped", failures: 2 };
    expect(summarizeHealth([chat({ ...failed, pendingSince: t - 500 })], t, 0, 0).state).toBe("degraded"); // just sent: not proof yet
    expect(summarizeHealth([chat({ ...failed, pendingSince: t - HELD_MS })], t, 0, 0).state).toBe("ok"); // held: the bridge is there
    expect(summarizeHealth([chat({ ...failed, pendingSince: t - 45_000 })], t, 0, 0).state).toBe("degraded"); // hung past its window
  });
});

// The same tester then saw "Today stale 48s" on the phone, again with nothing wrong: the Today tab, while another
// tab is showing, checks the vault once a minute, but was called stale after 16 seconds.
describe("a stale window follows the schedule in use", () => {
  const t = 1_000_000;
  const today = (over: Partial<HealthEntry>): HealthEntry => ({ label: "Today", updatedAt: 0, error: null, staleAfter: staleWindow(60_000), ...over });

  it("is two missed polls plus time for a slow answer", () => {
    expect([staleWindow(2500), staleWindow(8000), staleWindow(30_000), staleWindow(60_000)]).toEqual([15_000, 26_000, 70_000, 130_000]);
  });

  it("leaves a tab that checks once a minute alone between its checks, and flags it when checks stop", () => {
    expect(summarizeHealth([today({ updatedAt: t - 48_000 })], t, 0, 0).state).toBe("ok");
    expect(summarizeHealth([today({ updatedAt: t - 59_000 })], t, 0, 0).state).toBe("ok");
    expect(summarizeHealth([today({ updatedAt: t - 140_000 })], t, 0, 0).state).toBe("degraded");
  });

  it("is not stale the moment the tab is shown: the tighter window starts with the refresh it sends", () => {
    const shown = { staleAfter: staleWindow(8000), updatedAt: t - 50_000 };
    expect(summarizeHealth([today({ ...shown, pendingSince: t })], t, 0, 0).state).toBe("ok");
    expect(summarizeHealth([today({ ...shown, pendingSince: t })], t + 20_000, 0, 0).state).toBe("ok"); // a slow vault read
    expect(summarizeHealth([today({ ...shown, pendingSince: t })], t + 30_000, 0, 0).state).toBe("degraded"); // hung
  });
});

describe("coming back to the app", () => {
  it("gives up a request left open in the background and sends a fresh one at once", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const signals: AbortSignal[] = [];
    // Like a long-poll: resolves only when aborted (as a phone's frozen request never answers).
    const run = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    });
    const stop = poll(run, 150);
    expect(run).toHaveBeenCalledTimes(1);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(signals[1].aborted).toBe(false);
    stop();
  });

  it("keeps a request that was only hidden for a moment", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const signals: AbortSignal[] = [];
    const run = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    });
    const stop = poll(run, 150);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1_000);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });
});
