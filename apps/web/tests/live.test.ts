import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { liveConnected, liveInterval, liveWake, onLiveChange, resetLiveForTests } from "@/lib/live";
import { poll } from "@/lib/poll";

class FakeSource {
  static all: FakeSource[] = [];
  url: string;
  closed = false;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  listeners: Record<string, (() => void)[]> = {};
  constructor(url: string) {
    this.url = url;
    FakeSource.all.push(this);
  }
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ||= []).push(fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string) {
    for (const fn of this.listeners[type] || []) fn();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.all = [];
  vi.stubGlobal("EventSource", FakeSource);
});
afterEach(() => {
  resetLiveForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the live channel", () => {
  it("opens one connection for every listener, and closes with the last", () => {
    const a = onLiveChange(() => {});
    const b = onLiveChange(() => {});
    expect(FakeSource.all).toHaveLength(1);
    expect(FakeSource.all[0].url).toBe("/api/bridge/events");
    a();
    expect(FakeSource.all[0].closed).toBe(false);
    b();
    expect(FakeSource.all[0].closed).toBe(true);
  });

  it("calls listeners once for a burst of changes, and relaxes intervals while connected", () => {
    const fn = vi.fn();
    onLiveChange(fn);
    const es = FakeSource.all[0];
    expect(liveInterval(2500, 30_000)).toBe(2500);
    es.onmessage?.({ data: '{"type":"hello"}' });
    expect(liveConnected()).toBe(true);
    expect(liveInterval(2500, 30_000)).toBe(30_000);
    es.emit("change");
    es.emit("change");
    es.onmessage?.({ data: '{"type":"approved"}' });
    vi.advanceTimersByTime(60);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("backs off when the gateway is down instead of retrying every few seconds", () => {
    onLiveChange(() => {});
    FakeSource.all[0].onerror?.();
    expect(liveConnected()).toBe(false);
    vi.advanceTimersByTime(1999);
    expect(FakeSource.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSource.all).toHaveLength(2);
    FakeSource.all[1].onerror?.();
    vi.advanceTimersByTime(3999);
    expect(FakeSource.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSource.all).toHaveLength(3);
  });

  it("wakes a poll at once on a change, between its timer ticks", async () => {
    const run = vi.fn(async () => {});
    const stop = poll(run, 30_000, { wake: liveWake });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    const es = FakeSource.all[0];
    es.onmessage?.({ data: '{"type":"hello"}' }); // connected: the state change itself wakes it once
    await vi.advanceTimersByTimeAsync(0);
    const afterHello = run.mock.calls.length;
    es.emit("change");
    await vi.advanceTimersByTimeAsync(60);
    expect(run.mock.calls.length).toBe(afterHello + 1);
    stop();
  });
});
