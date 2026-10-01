import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const settings = {
  ok: true,
  stt: { provider: "local", providers: [{ id: "local", name: "Local Whisper", status: "ready" }] },
  tts: {
    provider: "voicestudio",
    voice: "profile:abc",
    voice_label: "VoiceStudio voice",
    providers: [
      { id: "edge", name: "Edge", status: "ready" },
      { id: "voicestudio", name: "VoiceStudio (local)", status: "ready" },
    ],
    voices: [
      { id: "design:male, middle-aged, low pitch, british accent", label: "British man, deep", group: "Designed · fast" },
      { id: "default", label: "OmniVoice default", group: "Designed · fast" },
      { id: "profile:abc", label: "Chief clone (cloned)", group: "Your VoiceStudio voices" },
    ],
  },
};

vi.mock("@/lib/bridge", () => ({
  fetchSettings: vi.fn(async () => settings),
  patchSettings: vi.fn(async () => settings),
  speakText: vi.fn(async () => ({ ok: true, data_url: "data:audio/mpeg;base64,AAAA", data_urls: ["data:audio/mpeg;base64,AAAA"] })),
}));
vi.mock("@/lib/web-push", () => ({
  pushCapability: vi.fn(async () => ({ available: false })),
  enableWebPush: vi.fn(),
  pushStatus: vi.fn(async () => "off"),
}));

import { patchSettings, speakText } from "@/lib/bridge";
import { SettingsPanel } from "@/components/settings-panel";

const play = vi.fn(async () => undefined);
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "Audio",
    class {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public src: string) {}
      play = play;
      pause() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  play.mockClear();
});

it("a plugin engine with a voice list gets a grouped picker, and choosing saves through the bridge", async () => {
  render(<SettingsPanel open phone={false} onClose={() => {}} category="voice" />);
  const select = (await screen.findByLabelText("VoiceStudio voice")) as HTMLSelectElement;
  expect(select.value).toBe("profile:abc");
  const groups = [...select.querySelectorAll("optgroup")].map((g) => g.label);
  expect(groups).toEqual(["Designed · fast", "Your VoiceStudio voices"]);
  expect(within(select.querySelectorAll("optgroup")[0] as HTMLElement).getAllByRole("option")).toHaveLength(2);
  fireEvent.change(select, { target: { value: "default" } });
  await waitFor(() => expect(patchSettings).toHaveBeenCalledWith({ tts: { voice: "default" } }));
});

it("preview speaks one line through the chief's real engine and plays it", async () => {
  render(<SettingsPanel open phone={false} onClose={() => {}} category="voice" />);
  const button = await screen.findByRole("button", { name: "Preview voice" });
  await act(async () => void fireEvent.click(button));
  expect(speakText).toHaveBeenCalledWith("Hi. This is how I'll sound.", 30_000);
  await waitFor(() => expect(play).toHaveBeenCalled());
  expect(await screen.findByRole("button", { name: "Stop preview" })).toBeInTheDocument();
});
