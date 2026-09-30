import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { splitSpeech } from "@/lib/speech-chunks";
import {
  enqueueSpeechParts,
  enqueueSpeechTask,
  getSpeechPhase,
  MISSED_AFTER_MS,
  PART_TIMEOUT_MS,
  START_TIMEOUT_MS,
  STALL_MS,
  stopSpeech,
} from "@/lib/voice-client";

class AudioMock extends EventTarget {
  static clips: AudioMock[] = [];
  static playResult: () => Promise<void> = () => Promise.resolve();
  src = "";
  paused = true;
  ended = false;
  currentTime = 0;
  constructor(src = "") {
    super();
    this.src = src;
    if (!src) AudioMock.clips.push(this);
  }
  setAttribute() {}
  removeAttribute() {
    this.src = "";
  }
  load() {}
  pause() {
    this.paused = true;
  }
  play() {
    this.paused = false;
    return AudioMock.playResult();
  }
}

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  vi.useFakeTimers();
  AudioMock.clips = [];
  AudioMock.playResult = () => Promise.resolve();
  visibility = "visible";
  vi.stubGlobal("Audio", AudioMock);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});
afterEach(() => {
  stopSpeech();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = () => vi.advanceTimersByTimeAsync(0);
const latest = () => AudioMock.clips.at(-1)!;

it("prepares part 2 while part 1 plays, and says Speaking only once sound starts", async () => {
  const second = vi.fn(async () => "b");
  const job = enqueueSpeechParts([async () => "a", second]);
  await flush();
  expect(getSpeechPhase()).toBe("preparing");
  expect(latest().src).toBe("a");
  expect(second).toHaveBeenCalledTimes(1);
  latest().dispatchEvent(new Event("playing"));
  expect(getSpeechPhase()).toBe("playing");
  latest().dispatchEvent(new Event("ended"));
  await flush();
  expect(latest().src).toBe("b");
  latest().dispatchEvent(new Event("playing"));
  latest().dispatchEvent(new Event("ended"));
  expect(await job).toEqual({ status: "played" });
  await flush();
  expect(getSpeechPhase()).toBe("idle");
});

it("gives up on a player that never starts, after one fresh retry", async () => {
  const job = enqueueSpeechTask(async () => "a");
  await flush();
  await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
  expect(AudioMock.clips.length).toBe(2);
  await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
  expect(await job).toEqual({ status: "failed", reason: "Playback never started" });
});

it("reports a clip whose position stops moving as stalled", async () => {
  const job = enqueueSpeechTask(async () => "a");
  await flush();
  const clip = latest();
  clip.dispatchEvent(new Event("playing"));
  clip.currentTime = 1.2;
  await vi.advanceTimersByTimeAsync(1000);
  await vi.advanceTimersByTimeAsync(STALL_MS + 1000);
  expect(await job).toEqual({ status: "failed", reason: "Playback stalled" });
});

it("times out a slow voice provider after one retry", async () => {
  const slow = vi.fn(() => new Promise<string>(() => {}));
  const job = enqueueSpeechTask(slow);
  await vi.advanceTimersByTimeAsync(PART_TIMEOUT_MS * 2 + 10);
  expect(slow).toHaveBeenCalledTimes(2);
  expect(await job).toEqual({ status: "failed", reason: "Voice took too long to prepare" });
});

it("waits for you to come back when the app was hidden, and plays if the reply is recent", async () => {
  visibility = "hidden";
  AudioMock.playResult = () => Promise.reject(new Error("NotAllowedError"));
  const job = enqueueSpeechTask(async () => "a");
  await flush();
  await vi.advanceTimersByTimeAsync(30_000);
  visibility = "visible";
  AudioMock.playResult = () => Promise.resolve();
  await vi.advanceTimersByTimeAsync(1000);
  const clip = latest();
  expect(clip.src).toBe("a");
  clip.dispatchEvent(new Event("playing"));
  clip.dispatchEvent(new Event("ended"));
  expect(await job).toEqual({ status: "played" });
});

it("offers a reply as missed when you come back more than two minutes later", async () => {
  visibility = "hidden";
  AudioMock.playResult = () => Promise.reject(new Error("NotAllowedError"));
  const job = enqueueSpeechTask(async () => "a");
  await flush();
  await vi.advanceTimersByTimeAsync(MISSED_AFTER_MS + 5000);
  visibility = "visible";
  await vi.advanceTimersByTimeAsync(1000);
  expect(await job).toEqual({ status: "missed", reason: "Missed while away" });
});

it("splits long replies with a short first chunk and keeps short replies whole", () => {
  expect(splitSpeech("Short reply. Done.")).toEqual(["Short reply. Done."]);
  const long = Array.from({ length: 20 }, (_, i) => `Sentence number ${i + 1} explains one more detail of the plan.`).join(" ");
  const chunks = splitSpeech(long);
  expect(chunks.length).toBeGreaterThan(2);
  expect(chunks[0].length).toBeLessThanOrEqual(240);
  expect(chunks[0].length).toBeGreaterThanOrEqual(60);
  expect(chunks.slice(1).every((c) => c.length <= 650)).toBe(true);
  expect(chunks.join(" ")).toBe(long);
  const runOn = "word ".repeat(400).trim();
  expect(splitSpeech(runOn).every((c) => c.length <= 650)).toBe(true);
});

it("holds the next part while paused between parts, and resumes without replaying the last one", async () => {
  const { pauseSpeech, resumeSpeech } = await import("@/lib/voice-client");
  let resolveSecond!: (url: string) => void;
  const job = enqueueSpeechParts([async () => "a", () => new Promise<string>((r) => (resolveSecond = r))]);
  await flush();
  const clip = latest();
  clip.dispatchEvent(new Event("playing"));
  clip.dispatchEvent(new Event("ended"));
  await flush();
  // Part 1 is done and part 2 is still being prepared: pause now.
  pauseSpeech();
  expect(getSpeechPhase()).toBe("paused");
  const plays = vi.spyOn(clip, "play");
  resolveSecond("b");
  await flush();
  expect(clip.src).not.toBe("b");
  expect(plays).not.toHaveBeenCalled();
  await resumeSpeech();
  await flush();
  // Resume starts part 2; it never replays the finished part 1.
  expect(clip.src).toBe("b");
  expect(plays).toHaveBeenCalledTimes(1);
  clip.dispatchEvent(new Event("playing"));
  clip.dispatchEvent(new Event("ended"));
  expect(await job).toEqual({ status: "played" });
});

it("Stop while paused between parts cancels the reply", async () => {
  const { pauseSpeech } = await import("@/lib/voice-client");
  const job = enqueueSpeechParts([async () => "a", async () => "b"]);
  await flush();
  latest().dispatchEvent(new Event("playing"));
  pauseSpeech();
  latest().dispatchEvent(new Event("ended"));
  await flush();
  expect(latest().src).toBe("a");
  stopSpeech();
  expect(await job).toEqual({ status: "cancelled" });
});
