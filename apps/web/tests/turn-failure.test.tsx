import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { NoticeBody, resetPhrase } from "@/components/chat/question";
import type { ChatNotice } from "@/lib/types";

/* A chat turn that failed after Hermes's retries (chat_state.turn_failure): a usage limit says when it resets and
   can retry then (Hermes's /retry, once); a provider that was down offers Retry now. */

let posts: { path: string; body: Record<string, unknown> }[];

beforeEach(() => {
  posts = [];
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = new URL(input, "http://127.0.0.1").pathname.replace("/api/bridge/", "");
    posts.push({ path, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return Response.json({ ok: true });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const limit = (resetsAt: number | null): ChatNotice => ({
  id: "o1",
  at: Date.now() / 1000,
  text: "Nous rate-limited every one of 3 attempts.\n\nProvider said: 429",
  source: "notice",
  turnFailure: { code: "limit", resetsAt, detail: "Nous rate-limited every one of 3 attempts.\n\nProvider said: 429" },
});

it("a usage limit says when it resets and retries then, once", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const resets = Date.now() / 1000 + 120;
  render(<NoticeBody notice={limit(resets)} onQuickReply={async () => undefined} />);
  expect(screen.getByText("Usage limit reached")).toBeTruthy();
  expect(screen.getByText(/has used up its plan for now\. It resets (at|tomorrow at) \d{1,2}:\d\d/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Retry (at|tomorrow at) / }));
  expect(screen.getByText(/Retrying (at|tomorrow at) .*Keep this open/)).toBeTruthy();
  expect(posts).toEqual([]);
  await act(async () => {
    vi.advanceTimersByTime(160_000);
  });
  await waitFor(() => expect(posts).toEqual([{ path: "retry", body: {} }]));
  expect(screen.getByText("Sent again.")).toBeTruthy();
});

it("anything newer in the chat drops a scheduled retry", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const notice = limit(Date.now() / 1000 + 60);
  const { rerender } = render(<NoticeBody notice={notice} onQuickReply={async () => undefined} />);
  fireEvent.click(screen.getByRole("button", { name: /^Retry (at|tomorrow at) / }));
  rerender(<NoticeBody notice={notice} />); // no longer the newest message
  await act(async () => {
    vi.advanceTimersByTime(120_000);
  });
  expect(posts).toEqual([]);
});

it("says when in a sentence, in the owner's own clock", () => {
  const now = new Date(2026, 9, 26, 9, 0);
  const at = (d: number, h: number) => new Date(2026, 9, 26 + d, h, 0).getTime() / 1000;
  expect(resetPhrase(at(0, 15), now)).toMatch(/^at \d{1,2}:00/);
  expect(resetPhrase(at(1, 15), now)).toMatch(/^tomorrow at /);
  expect(resetPhrase(at(3, 15), now)).toMatch(/^on \w+ at /);
});

it("a provider that was down offers Retry now and the details", async () => {
  const down: ChatNotice = { ...limit(null), turnFailure: { code: "down", resetsAt: null, detail: "OpenRouter returned a server error on all 3 attempts." } };
  render(<NoticeBody notice={down} />);
  expect(screen.getByText("The model didn't answer")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Retry (at|tomorrow|on) / })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(screen.getByText(/server error on all 3 attempts/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry now" }));
  await waitFor(() => expect(posts.map((p) => p.path)).toEqual(["retry"]));
});
