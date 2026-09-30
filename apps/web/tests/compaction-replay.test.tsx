import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ChiefChat } from "@/components/chief-chat";
import { dropReplays, planSpeech, SPEAK_BACKLOG } from "@/lib/replay-guard";
import type { ChatMessage } from "@/lib/types";

const first = "First reply, long enough to count as a real answer.";
const second = "Second reply, also long enough to be a real answer.";
const fresh = "Brand new reply after the compaction finished.";

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
    const t = "2026-09-24T11:00:00Z";
    if (!after) {
      return { sessionKey: "s", lastId: 2, generating: false, messages: [
        { id: 1, role: "assistant", content: first, timestamp: t },
        { id: 2, role: "assistant", content: second, timestamp: t },
      ] };
    }
    if (after < 6) {
      // Hermes compacts: a marker, the kept tail re-inserted (one flagged by the bridge, one not), then a new reply.
      return { sessionKey: "s", lastId: 6, generating: false, messages: [
        { id: 3, role: "user", content: "[CONTEXT COMPACTION] summary of earlier turns", timestamp: t },
        { id: 4, role: "assistant", content: first, timestamp: t, replay: true },
        { id: 5, role: "assistant", content: second, timestamp: t },
        { id: 6, role: "assistant", content: fresh, timestamp: t },
      ] };
    }
    return { sessionKey: "s", lastId: 6, generating: false, messages: [] };
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

it("never shows or reads again the conversation Hermes re-sends after compacting", async () => {
  localStorage.clear();
  render(<ChiefChat chief={undefined} lookAtEl={null} connected compact />);
  await waitFor(() => expect(api.speak).toHaveBeenCalled(), { timeout: 6000 });
  await waitFor(() => expect(api.calls).toBeGreaterThanOrEqual(3), { timeout: 6000 });
  const spoken = api.speak.mock.calls.map((call) => String(call[0]));
  expect(spoken.some((text) => text.includes("Brand new reply"))).toBe(true);
  expect(spoken.some((text) => text.includes("First reply") || text.includes("Second reply"))).toBe(false);
  expect(screen.getAllByText(first)).toHaveLength(1);
  expect(screen.getAllByText(second)).toHaveLength(1);
}, 12_000);

const msg = (id: number, content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role: "assistant", content, ...extra });

it("drops flagged copies, and unflagged repeats only on a page that carries a compaction marker", () => {
  const prev = [msg(1, first)];
  expect(dropReplays(prev, [msg(2, first, { replay: true }), msg(3, fresh)]).map((m) => m.id)).toEqual([3]);
  // No marker: a repeated text is a real message (Chief may say the same thing twice).
  expect(dropReplays(prev, [msg(2, first)]).map((m) => m.id)).toEqual([2]);
  const marker = { ...msg(2, "[CONTEXT COMPACTION] x"), role: "user" };
  expect(dropReplays(prev, [marker, msg(3, first), msg(4, fresh)]).map((m) => m.id)).toEqual([2, 4]);
});

it("reads the newest reply when too many are waiting, and never repeats one already read", () => {
  const replies = Array.from({ length: SPEAK_BACKLOG + 2 }, (_, i) => msg(10 + i, `Reply number ${i}, long enough to count as distinct.`));
  const candidates = replies.map((m) => ({ message: m, script: m.content }));
  const plan = planSpeech(candidates, replies, new Set());
  expect(plan.speak.map((c) => c.message.id)).toEqual([10 + SPEAK_BACKLOG + 1]);
  expect(plan.held).toHaveLength(SPEAK_BACKLOG + 1);
  const again = planSpeech([{ message: msg(99, first), script: first }], [msg(1, first), msg(99, first)], new Set());
  expect(again.speak).toHaveLength(0);
  expect(again.repeats).toHaveLength(1);
  // Short replies may legitimately repeat.
  expect(planSpeech([{ message: msg(5, "Done."), script: "Done." }], [msg(1, "Done."), msg(5, "Done.")], new Set()).speak).toHaveLength(1);
});
