import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ChiefChat } from "@/components/chief-chat";

const api = vi.hoisted(() => ({ pinned: true as boolean, reset: vi.fn(async () => ({ ok: true })) }));
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
    messages: [{ id: 1, role: "assistant", content: "Switched to the plan's model to keep going.", timestamp: "2026-11-10T11:00:00Z" }],
    modelOverride: api.pinned ? { model: "nova-small", provider: "nous" } : null,
  }),
  fetchVoiceConfig: async () => ({ ok: true }),
  resetChatModel: api.reset,
  sendToChief: vi.fn(),
  resolveApproval: vi.fn(),
}));
vi.mock("@/components/bot-face", () => ({ BotFace: () => null, FaceRing: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/emoji-picker", () => ({ EmojiPicker: () => null }));
vi.mock("@/components/mic-button", () => ({ MicButton: () => null }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: unknown }) => children }));

afterEach(cleanup);

it("a chat switched to another model says which, and goes back to the usual one", async () => {
  localStorage.clear();
  render(<ChiefChat chief={undefined} lookAtEl={null} connected compact />);
  expect(await screen.findByText("nova-small")).toBeInTheDocument();
  api.pinned = false;
  fireEvent.click(screen.getByRole("button", { name: "Back to your usual model" }));
  await waitFor(() => expect(api.reset).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByText("nova-small")).toBeNull(), { timeout: 8000 });
}, 15_000);
