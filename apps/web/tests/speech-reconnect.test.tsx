import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ChiefChat } from "@/components/chief-chat";

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
    const history = { id: 1, role: "assistant", content: "Old reply from before.", timestamp: "2026-09-23T08:00:00Z" };
    const fresh = { id: 2, role: "assistant", content: "Ada finished the print studio card.", timestamp: "2026-09-23T09:00:00Z" };
    if (!after) return { sessionKey: "s", lastId: 1, messages: [history], generating: false };
    return after < 2 ? { sessionKey: "s", lastId: 2, messages: [fresh], generating: false } : { sessionKey: "s", lastId: 2, messages: [], generating: false };
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

it("speaks a reply that arrived during a connection blip once the connection is back", async () => {
  localStorage.clear();
  const view = render(<ChiefChat chief={undefined} lookAtEl={null} connected={false} compact />);
  await waitFor(() => expect(api.calls).toBeGreaterThanOrEqual(2), { timeout: 6000 });
  expect(api.speak).not.toHaveBeenCalled();
  view.rerender(<ChiefChat chief={undefined} lookAtEl={null} connected compact />);
  await waitFor(() => expect(api.speak).toHaveBeenCalled(), { timeout: 3000 });
  expect(api.speak.mock.calls[0][0]).toContain("Ada finished");
  // The old reply was history when the page loaded: never spoken.
  expect(api.speak.mock.calls.every((call) => !String(call[0]).includes("Old reply"))).toBe(true);
}, 12_000);
