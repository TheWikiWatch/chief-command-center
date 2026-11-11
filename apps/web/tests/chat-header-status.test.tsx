import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/components/bot-face", () => ({ BotFace: () => null, FaceRing: ({ children }: { children: unknown }) => children }));

import { ChatHeader, type ChiefMood } from "@/components/chat/chat-header";

/* Review A1: screen readers hear the header's line from one region that stays put. */

afterEach(cleanup);

const header = (mood: ChiefMood, status?: { text: string; tone: string; announce?: string }) => (
  <ChatHeader chief={undefined} mood={mood} status={status} voiceLabel="" connected onPauseToggle={() => {}} onStop={() => {}} />
);

it("one status region says what the chief is doing, and a new question in full", async () => {
  const view = render(header("online"));
  const region = screen.getByText("Online", { selector: "[role=status]" });
  view.rerender(header("thinking"));
  // The same element: a live region that appears with its text isn't announced.
  expect(screen.getByText("Thinking…", { selector: "[role=status]" })).toBe(region);
  view.rerender(header("online", { text: "Has a question for you", tone: "text-warn", announce: "Nova has a question for you: Which folder should I file it in?" }));
  expect(region).toHaveTextContent("Nova has a question for you: Which folder should I file it in?");
  // The animated line (in once the old one has gone) is for the eyes only.
  const shown = (await screen.findByText("Has a question for you")).closest("p")!;
  expect(shown).toHaveAttribute("aria-hidden", "true");
  expect(shown).not.toHaveAttribute("aria-live");
});
