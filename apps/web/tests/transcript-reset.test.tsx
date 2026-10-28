import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ChiefChat } from "@/components/chief-chat";

const plan = "Here is the plan for the week, in three parts.";
const fresh = "Brand new answer after Send again, read aloud.";

const api = vi.hoisted(() => ({
  calls: 0,
  speak: vi.fn(async (_text: string, _timeout?: number) => ({ ok: true, data_url: "data:audio/mpeg;base64,AAAA" })),
}));
vi.mock("@blobatar/react/gaze", () => ({ useGaze: () => ({ ref: null, lookAt: () => {} }) }));
vi.mock("@/lib/dashboard-prefs", () => ({
  VOICE_EVENT: "voice",
  useDashboardPrefs: () => ({ fontPx: 16, speakOn: true, compactChat: false, setSpeak: () => {} }),
}));
vi.mock("@/lib/bridge", () => ({
  fetchTranscript: async (after: number) => {
    api.calls += 1;
    const t = "2026-10-28T11:00:00Z";
    if (!after) {
      return { sessionKey: "s", lastId: 4, generating: false, messages: [
        { id: 1, role: "user", content: "Plan the week", timestamp: t, uid: "u1" },
        { id: 2, role: "assistant", content: plan, timestamp: t, uid: "u2" },
        { id: 3, role: "user", content: "WORK on the restart test", timestamp: t, uid: "u3" },
        { id: 4, role: "assistant", content: "Gateway shutting down: this turn was interrupted.", timestamp: t, uid: "u4", failedTurn: true, failedReason: "restart" },
      ] };
    }
    if (after < 8) {
      // Hermes's /retry wrote the conversation again with new ids, without the cut-off turn, and the re-sent turn ran.
      return { sessionKey: "s", lastId: 8, generating: false, reset: true, more: false, messages: [
        { id: 5, role: "user", content: "Plan the week", timestamp: t, uid: "u1" },
        { id: 6, role: "assistant", content: plan, timestamp: t, uid: "u2" },
        { id: 7, role: "user", content: "WORK on the restart test", timestamp: t, uid: "u5" },
        { id: 8, role: "assistant", content: fresh, timestamp: t, uid: "u6" },
      ] };
    }
    return { sessionKey: "s", lastId: 8, generating: false, messages: [] };
  },
  fetchVoiceConfig: async () => ({ ok: true }),
  sendToChief: vi.fn(),
  resolveApproval: vi.fn(),
  speakText: api.speak,
}));
vi.mock("@/components/bot-face", () => ({ BotFace: () => null, FaceRing: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/emoji-picker", () => ({ EmojiPicker: () => null }));
vi.mock("@/components/mic-button", () => ({ MicButton: () => null }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: unknown }) => children }));

afterEach(cleanup);

it("shows a conversation Hermes rewrote once, without the cut-off turn, and reads only the new answer", async () => {
  localStorage.clear();
  render(<ChiefChat chief={undefined} lookAtEl={null} connected compact />);
  await waitFor(() => expect(api.speak).toHaveBeenCalled(), { timeout: 6000 });
  await waitFor(() => expect(api.calls).toBeGreaterThanOrEqual(3), { timeout: 6000 });
  const spoken = api.speak.mock.calls.map((call) => String(call[0]));
  expect(spoken.some((text) => text.includes("Brand new answer"))).toBe(true);
  expect(spoken.some((text) => text.includes("Here is the plan"))).toBe(false);
  expect(screen.getAllByText(plan)).toHaveLength(1);
  expect(screen.getAllByText("WORK on the restart test")).toHaveLength(1);
  expect(screen.queryByText(/Cut off when/)).toBeNull();
}, 12_000);
