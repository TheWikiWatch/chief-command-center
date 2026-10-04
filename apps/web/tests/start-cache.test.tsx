import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ChiefChat } from "@/components/chief-chat";
import { clearStart, readStart, writeStart } from "@/lib/start-cache";
import { markStart, resetStartForTests, useStartTiming } from "@/lib/startup-timing";

// A tester's Android phone discarded the app in the background, so every return redrew from scratch and waited
// for the PC: the chat, the team and Today now reappear as they were, then refresh.

const api = vi.hoisted(() => ({ transcript: vi.fn(), earlier: vi.fn() }));
vi.mock("@blobatar/react/gaze", () => ({ useGaze: () => ({ ref: null, lookAt: () => {} }) }));
vi.mock("@/lib/dashboard-prefs", () => ({ VOICE_EVENT: "voice", fullPhotosOn: () => true, useDashboardPrefs: () => ({ fontPx: 16, speakOn: false, compactChat: false }) }));
vi.mock("@/lib/bridge", () => ({
  fetchTranscript: api.transcript,
  fetchEarlier: api.earlier,
  fetchVoiceConfig: async () => ({ ok: true }),
  sendToChief: vi.fn(),
  resolveApproval: vi.fn(),
}));
vi.mock("@/components/bot-face", () => ({ BotFace: () => null, FaceRing: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/emoji-picker", () => ({ EmojiPicker: () => null }));
vi.mock("@/components/mic-button", () => ({ MicButton: () => null }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: unknown }) => children }));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  resetStartForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("keeps what was saved, per scope, and forgets it when stale or too big", () => {
  writeStart("chat", [{ id: 1 }], "main");
  vi.advanceTimersByTime(1000);
  expect(readStart("chat", "main")).toEqual([{ id: 1 }]);
  expect(readStart("chat", "other-thread")).toBeNull();
  expect(readStart("chat", "main", Date.now() + 8 * 24 * 3600 * 1000)).toBeNull(); // a week on: not shown
  writeStart("chat", "x".repeat(500_000), "main");
  vi.advanceTimersByTime(1000);
  expect(readStart("chat", "main")).toBeNull(); // too big to keep: the next start waits for the PC
  writeStart("today", { a: 1 });
  vi.advanceTimersByTime(1000);
  clearStart();
  expect(readStart("today")).toBeNull();
});

it("a cold start shows the chat as it was before the PC answers, and the answer replaces it", async () => {
  localStorage.setItem(
    "chief.start.chat",
    JSON.stringify({ at: Date.now(), scope: "main", value: [{ id: 41, role: "assistant", content: "kept from last time", timestamp: "1790000000" }] }),
  );
  let answer: (v: unknown) => void = () => {};
  api.transcript.mockReturnValueOnce(new Promise((r) => (answer = r))).mockReturnValue(new Promise(() => {}));
  render(<ChiefChat chief={undefined} lookAtEl={null} connected compact />);
  expect(screen.getByText("kept from last time")).toBeTruthy(); // in the first frame, before any answer
  await act(async () => {
    answer({ sessionKey: "s", lastId: 42, messages: [{ id: 42, role: "assistant", content: "fresh from the PC", timestamp: "1790000001" }] });
  });
  await waitFor(() => expect(screen.getByText("fresh from the PC")).toBeTruthy());
  expect(screen.queryByText("kept from last time")).toBeNull();
});

function Timing() {
  const { marks } = useStartTiming();
  return <span data-testid="t">{JSON.stringify(marks)}</span>;
}

it("marks each part of a start once", () => {
  render(<Timing />);
  act(() => {
    markStart("app", 900);
    markStart("chat", 2400);
    markStart("chat", 9000); // a later answer doesn't move it
  });
  expect(screen.getByTestId("t").textContent).toBe('{"app":900,"chat":2400}');
});
