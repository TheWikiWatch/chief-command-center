import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/bridge", () => ({
  fetchSettings: vi.fn(async () => ({
    stt: { provider: "local", providers: [{ id: "local", name: "Local Whisper", status: "ready" }] },
    tts: {
      provider: "edge",
      voice: "en-US-GuyNeural",
      voices: [{ id: "en-US-GuyNeural", label: "Guy" }],
      providers: [
        { id: "edge", name: "Edge", status: "ready" },
        { id: "openai", name: "OpenAI", status: "ready" },
        { id: "elevenlabs", name: "ElevenLabs", status: "needs_keys", env_key: "ELEVENLABS_API_KEY" },
      ],
    },
  })),
  patchSettings: vi.fn(async () => ({})),
}));
vi.mock("@/lib/web-push", () => ({
  pushCapability: vi.fn(async () => ({ available: false })),
  enableWebPush: vi.fn(),
  pushStatus: vi.fn(async () => "off"),
}));

import { patchSettings } from "@/lib/bridge";
import { SettingsPanel } from "@/components/settings-panel";
import { FONT_KEY } from "@/lib/dashboard-prefs";
import { FX_KEY } from "@/lib/fx-prefs";

const stored = () => JSON.parse(localStorage.getItem(FX_KEY) || "{}");

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it("switches each sound and haptic on or off, and the master disables the rows", async () => {
  render(<SettingsPanel open phone onClose={() => {}} />);
  const reply = screen.getByRole("switch", { name: "Chief replies sound" });
  expect(reply).toHaveAttribute("aria-checked", "true");
  fireEvent.click(reply);
  expect(stored().sound.reply).toBe(false);
  expect(screen.getByRole("switch", { name: "Chief replies sound" })).toHaveAttribute("aria-checked", "false");

  fireEvent.click(screen.getByRole("switch", { name: "Button taps vibration" }));
  expect(stored().haptics.tap).toBe(true);

  fireEvent.click(screen.getByRole("switch", { name: "Sounds" }));
  expect(stored().sound.master).toBe(false);
  expect(screen.getByRole("switch", { name: "Approval needed sound" })).toBeDisabled();
  expect(screen.getByRole("switch", { name: "Approval needed vibration" })).not.toBeDisabled();
  await waitFor(() => expect(screen.getByRole("radio", { name: /Edge/ })).toBeInTheDocument());
});

it("keeps text size adjustable and sets interface size, motion and ambience", async () => {
  render(<SettingsPanel open phone onClose={() => {}} />);
  fireEvent.click(screen.getByRole("radio", { name: "18" }));
  expect(localStorage.getItem(FONT_KEY)).toBe("18");
  fireEvent.click(screen.getByRole("radio", { name: "Large" }));
  fireEvent.click(screen.getByRole("radio", { name: "Reduced" }));
  fireEvent.click(screen.getByRole("radio", { name: "Low" }));
  expect(stored()).toMatchObject({ uiScale: "large", motion: "reduced", ambient: "low" });
  fireEvent.click(screen.getByRole("switch", { name: "Fleet change toasts" }));
  expect(stored().fleetToasts).toBe(false);
  await waitFor(() => expect(screen.getByRole("radio", { name: /Edge/ })).toBeInTheDocument());
});

it("still picks Chief's voice engine through Hermes", async () => {
  render(<SettingsPanel open phone onClose={() => {}} />);
  const edge = await screen.findByRole("radio", { name: /Edge/ });
  expect(edge).toHaveAttribute("aria-checked", "true");
  fireEvent.click(screen.getByRole("radio", { name: /OpenAI/ }));
  await waitFor(() => expect(patchSettings).toHaveBeenCalledWith({ tts: { provider: "openai" } }));
});

it("a provider's key box opens only when that provider is picked", async () => {
  render(<SettingsPanel open phone onClose={() => {}} />);
  const eleven = await screen.findByRole("radio", { name: /ElevenLabs/ });
  expect(screen.queryByPlaceholderText("API key")).toBeNull();
  fireEvent.click(eleven);
  expect(screen.getByPlaceholderText("API key")).toBeInTheDocument();
  fireEvent.click(eleven);
  expect(screen.queryByPlaceholderText("API key")).toBeNull();
});
