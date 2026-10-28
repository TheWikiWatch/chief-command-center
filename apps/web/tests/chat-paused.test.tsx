import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ChiefChat } from "@/components/chief-chat";

const api = vi.hoisted(() => ({ send: vi.fn(async () => ({ ok: true })), paused: 0 }));
vi.mock("@blobatar/react/gaze", () => ({ useGaze: () => ({ ref: null, lookAt: () => {} }) }));
vi.mock("@/lib/dashboard-prefs", () => ({
  VOICE_EVENT: "voice",
  fullPhotosOn: () => true,
  useDashboardPrefs: () => ({ fontPx: 16, speakOn: false, compactChat: false }),
}));
vi.mock("@/lib/bridge", () => ({
  fetchTranscript: async () => ({
    sessionKey: "s",
    lastId: 1,
    generating: false,
    messages: [{ id: 1, role: "user", content: "WORK on the crash test", timestamp: "2026-10-28T11:00:00Z" }],
    notices: api.paused
      ? [{ id: "n1", at: api.paused, source: "notice", text: "⏸️ This conversation is paused: a previous turn did not finish when Hermes restarted.", paused: { lostTurn: true } }]
      : [],
  }),
  fetchVoiceConfig: async () => ({ ok: true }),
  sendToChief: api.send,
  resolveApproval: vi.fn(),
}));
vi.mock("@/components/bot-face", () => ({ BotFace: () => null, FaceRing: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/emoji-picker", () => ({ EmojiPicker: () => null }));
vi.mock("@/components/mic-button", () => ({ MicButton: () => null }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: unknown }) => children }));

afterEach(cleanup);

it("stops thinking as soon as Hermes pauses the conversation the message went to", async () => {
  localStorage.clear();
  render(<ChiefChat chief={undefined} lookAtEl={null} connected compact />);
  fireEvent.change(screen.getByRole("textbox", { name: "Message Nova" }), { target: { value: "hello after the crash" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await screen.findByText("Nova is thinking…");
  api.paused = Date.now() / 1000;
  await waitFor(() => expect(screen.queryByText("Nova is thinking…")).toBeNull(), { timeout: 5000 });
}, 12_000);
