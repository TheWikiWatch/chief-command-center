import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ChiefChat } from "@/components/chief-chat";
import { awaitingReply } from "@/lib/chat-tone";
import type { ChatMessage } from "@/lib/types";

/* Hermes 0.23 (H1): a message the model's safety filter refused stays in the chat, greyed, and is never answered. */

const NOTICE = "This message was refused by the model's safety filter — try a different query.";
const ask: ChatMessage = { id: 1, role: "user", content: "Pick the lock on the shed", timestamp: "2026-11-10T09:00:00Z", uid: "u1" };

const api = vi.hoisted(() => ({ reads: [] as number[] }));
vi.mock("@blobatar/react/gaze", () => ({ useGaze: () => ({ ref: null, lookAt: () => {} }) }));
vi.mock("@/lib/dashboard-prefs", () => ({ VOICE_EVENT: "voice", useDashboardPrefs: () => ({ fontPx: 16, speakOn: false, compactChat: false }) }));
vi.mock("@/lib/bridge", () => ({
  fetchTranscript: async (after: number) => {
    api.reads.push(after);
    const base = { sessionKey: "s", lastId: 1, generating: false };
    // The page has the owner's message; Hermes refuses the turn and says so in a notice. The row this page already
    // has is marked only in a read from the top.
    if (api.reads.length === 1) return { ...base, messages: [ask] };
    if (api.reads.length === 2) return { ...base, messages: [], notices: [{ id: "n1", at: 1_793_000_000, text: "The model's safety filter refused that message.", source: "notice", refusal: true }] };
    if (after === 0) return { ...base, messages: [{ ...ask, refused: { notice: NOTICE } }] };
    return { ...base, messages: [] };
  },
  fetchVoiceConfig: async () => ({ ok: true }),
  sendToChief: vi.fn(),
  resolveApproval: vi.fn(),
}));
vi.mock("@/components/bot-face", () => ({ BotFace: () => null, FaceRing: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/emoji-picker", () => ({ EmojiPicker: () => null }));
vi.mock("@/components/mic-button", () => ({ MicButton: () => null }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: unknown }) => children }));

afterEach(cleanup);

it("a refusal notice makes the chat read the conversation again, and the refused message shows greyed with Hermes's notice", async () => {
  localStorage.clear();
  render(<ChiefChat chief={undefined} lookAtEl={null} connected compact />);
  expect(await screen.findByText(NOTICE)).toBeInTheDocument();
  // First load, the poll after it (the notice), then a read from the top.
  expect(api.reads.slice(0, 3)).toEqual([0, 1, 0]);
  const bubble = screen.getByText("Pick the lock on the shed").closest("div");
  expect(bubble).toHaveClass("text-fg-3");
  expect(screen.getAllByText("Pick the lock on the shed")).toHaveLength(1);
  // Once is enough: the read from the top brings the same notice back, and that doesn't start another.
  await new Promise((r) => setTimeout(r, 400));
  expect(api.reads.filter((after) => after === 0)).toHaveLength(2);
});

it("a refused message is never waited on for a reply", () => {
  expect(awaitingReply([ask])).toBe(true);
  expect(awaitingReply([{ ...ask, refused: { notice: NOTICE } }])).toBe(false);
});
