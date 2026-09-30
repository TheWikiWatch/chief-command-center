import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const level = { value: 0 };
vi.mock("@/lib/audio-level", () => ({ meterStream: vi.fn(), detach: vi.fn(), readLevel: () => level.value }));
vi.mock("@/lib/voice-client", () => ({
  pickRecorderMime: () => "audio/webm",
  blobToDataUrl: async () => "data:audio/webm;base64,AAAA",
  playableAudioUrl: (url: string) => ({ url, revoke: () => undefined }),
}));

import { CheckMySystem } from "@/components/voice/check-my-system";
import { loadVoiceCheck } from "@/lib/mic-device";

type Handler = (body: Record<string, unknown>) => unknown;
const READY = {
  ok: true,
  default: "base",
  models: [
    { id: "base", label: "Standard", bytes: 147_882_941, installed: true, source: "" },
    { id: "tiny", label: "Small", bytes: 78_203_619, installed: false, source: "" },
  ],
  job: null,
  stt: { provider: "local", enabled: true, local: true, ready: true },
};
const MISSING = { ...READY, models: READY.models.map((m) => ({ ...m, installed: false })), stt: { ...READY.stt, ready: false } };

function route(handlers: Record<string, Handler>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://127.0.0.1:3100").pathname.replace("/api/bridge/", "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ path, body });
      const handler = handlers[path];
      return Response.json(handler ? handler(body) : { ok: false, error: `no handler for ${path}` });
    }),
  );
  return calls;
}

function stubMedia(getUserMedia: () => Promise<MediaStream>, devices: Partial<MediaDeviceInfo>[] = []) {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(getUserMedia), enumerateDevices: vi.fn(async () => devices) },
  });
}
const fakeStream = () => ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream;
const domError = (name: string) => Object.assign(new Error(name), { name });

class FakeRecorder {
  mimeType = "audio/webm";
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  start() {}
  stop() {
    this.ondataavailable?.({ data: new Blob(["x"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

beforeEach(() => {
  level.value = 0;
  localStorage.clear();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(performance.now()), 5) as unknown as number);
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("reports a working microphone from its level, and lets the owner pick a device", async () => {
  route({ "voice/model": () => READY });
  stubMedia(async () => fakeStream(), [
    { kind: "audioinput", deviceId: "default", label: "Default" },
    { kind: "audioinput", deviceId: "usb-1", label: "USB mic" },
    { kind: "audioinput", deviceId: "desk-2", label: "Desk mic" },
  ]);
  render(<CheckMySystem />);
  const select = await screen.findByRole("combobox");
  fireEvent.change(select, { target: { value: "desk-2" } });
  expect(localStorage.getItem("chief-mic-device")).toBe("desk-2");
  level.value = 0.3;
  fireEvent.click(screen.getByRole("button", { name: "Test my microphone" }));
  expect(await screen.findByText("Your microphone works.")).toBeTruthy();
  const constraints = (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mock.calls[0][0] as { audio: MediaTrackConstraints };
  expect(constraints.audio.deviceId).toEqual({ ideal: "desk-2" });
  await waitFor(() => expect(loadVoiceCheck()?.mic).toBe("ok"));
});

it.each([
  ["NotAllowedError", /Microphone access is blocked/],
  ["NotFoundError", /No microphone found/],
  ["NotReadableError", /in use by another app/],
])("explains %s in plain words", async (name, message) => {
  route({ "voice/model": () => READY });
  stubMedia(async () => Promise.reject(domError(name)));
  render(<CheckMySystem />);
  fireEvent.click(await screen.findByRole("button", { name: "Test my microphone" }));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});

it("says so when the microphone hears nothing", async () => {
  route({ "voice/model": () => READY });
  stubMedia(async () => fakeStream());
  render(<CheckMySystem silenceMs={40} />);
  fireEvent.click(await screen.findByRole("button", { name: "Test my microphone" }));
  expect(await screen.findByText(/We didn't hear anything/)).toBeTruthy();
});

it("plays a test phrase and asks whether it was heard; a voice failure is explained", async () => {
  let fail = false;
  route({
    "voice/model": () => READY,
    speak: () => (fail ? { ok: false, error: "Microsoft Edge service unreachable" } : { ok: true, data_url: "data:audio/mpeg;base64,AAAA" }),
  });
  stubMedia(async () => fakeStream());
  vi.stubGlobal(
    "Audio",
    class {
      onended = null;
      play = vi.fn(async () => undefined);
    },
  );
  render(<CheckMySystem />);
  fireEvent.click(await screen.findByRole("button", { name: "Play a test phrase" }));
  expect(await screen.findByText("Did you hear it?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "No" }));
  expect(screen.getByText(/Check the volume/)).toBeTruthy();
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "Play it again" }));
  expect(await screen.findByText(/Voice unavailable: Microsoft Edge service unreachable\. Text replies still work\./)).toBeTruthy();
});

it("asks before downloading the speech model, shows progress, and can cancel and resume", async () => {
  let state: Record<string, unknown> = MISSING;
  const calls = route({
    "voice/model": () => state,
    "voice/model/download": (body) => {
      state = { ...MISSING, job: { id: body.id, state: "downloading", received: 50_000_000, total: 147_882_941, error: "" } };
      return { ok: true };
    },
    "voice/model/cancel": () => {
      state = { ...MISSING, job: { id: "base", state: "cancelled", received: 50_000_000, total: 147_882_941, error: "" } };
      return { ok: true };
    },
  });
  stubMedia(async () => fakeStream());
  render(<CheckMySystem />);
  expect(await screen.findByText(/runs on this PC.*Download it now \(148 MB from Hugging Face\)\?/)).toBeTruthy();
  expect(calls.some((c) => c.path === "voice/model/download")).toBe(false); // nothing without a tap
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(await screen.findByText("50 MB of 148 MB")).toBeTruthy();
  expect(calls.find((c) => c.path === "voice/model/download")?.body).toEqual({ id: "base" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(await screen.findByText(/picks up where it stopped/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Resume download" })).toBeTruthy();
});

it("offers the smaller model, and Not now leaves voice typing off without blocking anything", async () => {
  const calls = route({ "voice/model": () => MISSING, "voice/model/download": () => ({ ok: true }) });
  stubMedia(async () => fakeStream());
  render(<CheckMySystem />);
  fireEvent.click(await screen.findByRole("button", { name: /Use the smaller model instead \(78 MB/ }));
  await waitFor(() => expect(calls.find((c) => c.path === "voice/model/download")?.body).toEqual({ id: "tiny" }));
  cleanup();
  render(<CheckMySystem />);
  fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
  expect(screen.getByText(/Voice typing stays off/)).toBeTruthy();
});

it("transcribes a short phrase without touching the conversation, and handles no speech and a missing model", async () => {
  let reply: Record<string, unknown> = { ok: true, transcript: "remind me to call the plumber" };
  const calls = route({ "voice/model": () => READY, transcribe: () => reply });
  stubMedia(async () => fakeStream());
  render(<CheckMySystem recordMs={10} />);
  fireEvent.click(await screen.findByRole("button", { name: "Say a short phrase" }));
  expect(await screen.findByText("We heard: “remind me to call the plumber”")).toBeTruthy();
  expect(calls.filter((c) => c.path === "send")).toEqual([]);
  reply = { ok: true, transcript: "", no_speech: true };
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText(/catch any words/)).toBeTruthy();
  reply = { ok: false, code: "model_missing", error: "Voice typing needs its speech model." };
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Voice typing needs its speech model.")).toBeTruthy();
  await act(async () => undefined);
});
