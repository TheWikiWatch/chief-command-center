import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ChiefChat } from "@/components/chief-chat";

const markdown = vi.hoisted(() => ({ renders: 0, threads: 0 }));
vi.mock("@/components/chat/thread", async () => {
  const actual = await vi.importActual<typeof import("@/components/chat/thread")>("@/components/chat/thread");
  return {
    ...actual,
    Thread: (props: Parameters<typeof actual.Thread>[0]) => {
      markdown.threads += 1;
      return <actual.Thread {...props} />;
    },
  };
});
vi.mock("@blobatar/react/gaze", () => ({ useGaze: () => ({ ref: null, lookAt: () => {} }) }));
vi.mock("@/lib/dashboard-prefs", () => ({ VOICE_EVENT: "voice", fullPhotosOn: () => true, useDashboardPrefs: () => ({ fontPx: 16, speakOn: false, compactChat: false }) }));
vi.mock("@/lib/bridge", () => ({
  fetchTranscript: async () => ({
    sessionKey: "s",
    lastId: 3,
    generating: false,
    messages: [1, 2, 3].map((id) => ({ id, role: "assistant", content: `reply ${id}`, timestamp: "2026-09-23T20:00:00Z" })),
  }),
  fetchVoiceConfig: async () => ({ ok: true }),
  sendToChief: vi.fn(),
  resolveApproval: vi.fn(),
}));
vi.mock("@/components/bot-face", () => ({ BotFace: () => null, FaceRing: ({ children }: { children: unknown }) => children }));
vi.mock("@/components/emoji-picker", () => ({ EmojiPicker: () => null }));
vi.mock("@/components/mic-button", () => ({ MicButton: () => null }));
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children: string }) => {
    markdown.renders += 1;
    return <div>{children}</div>;
  },
}));

afterEach(() => cleanup());

it("typing in the message box doesn't re-render the thread", async () => {
  render(<ChiefChat chief={undefined} lookAtEl={null} connected compact />);
  await screen.findByText("reply 3");
  await waitFor(() => expect(markdown.renders).toBeGreaterThan(0));
  const before = markdown.renders;
  const threadsBefore = markdown.threads;
  const box = screen.getByRole("textbox", { name: /Message/ });
  for (const value of ["h", "he", "hel", "hello"]) fireEvent.change(box, { target: { value } });
  expect(box).toHaveValue("hello");
  expect(markdown.renders).toBe(before);
  // The thread component itself isn't rendered again either: only the box is.
  expect(markdown.threads).toBe(threadsBefore);
});
