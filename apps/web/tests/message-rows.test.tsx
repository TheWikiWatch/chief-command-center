import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: string }) => <div>{children}</div> }));

import { Thread } from "@/components/chat/thread";
import { MAX_KEPT_MESSAGES, mergeMsgs, trimNotices } from "@/components/chief-chat";
import type { ChatMessage, ChatNotice } from "@/lib/types";

const at = "2026-11-10T09:00:00Z";
const reply = (id: number, content: string): ChatMessage => ({ id, role: "assistant", content, timestamp: at });
const thread = (messages: ChatMessage[]) => <Thread messages={messages} chief={undefined} awaiting={false} waitingApproval={false} connected onSuggestion={() => undefined} />;

afterEach(cleanup);

it("your message stays the same row when its stored copy replaces the bubble, so it doesn't animate in twice", () => {
  const bubble: ChatMessage = { id: 1_731_000_000_000, role: "user", content: "Book the train", timestamp: at, delivery: "sent" };
  const before = [reply(5, "Morning"), bubble];
  const view = render(thread(before));
  const shown = screen.getByText("Book the train");
  const after = mergeMsgs(before, [{ id: 6, role: "user", content: "Book the train", timestamp: at }]);
  expect(after.map((m) => [m.id, m.rowKey])).toEqual([
    [5, undefined],
    [6, `m-${bubble.id}`],
  ]);
  view.rerender(thread(after));
  expect(screen.getByText("Book the train")).toBe(shown);
});

it("a queued message keeps its row from the outbox to the stored copy", () => {
  const queued: ChatMessage = { id: 1_731_000_000_000, rowKey: "q-abc", role: "user", content: "Later", timestamp: at, delivery: "queued", queueId: "abc" };
  const view = render(thread([reply(5, "Morning"), queued]));
  const shown = screen.getByText("Later");
  // Delivered: the chat's "sent" bubble carries the queued bubble's row (chief-chat.tsx), then the stored copy takes it.
  const sent: ChatMessage = { id: 1_731_000_000_500, rowKey: "q-abc", role: "user", content: "Later", timestamp: at, delivery: "sent" };
  view.rerender(thread([reply(5, "Morning"), sent]));
  expect(screen.getByText("Later")).toBe(shown);
  const stored = mergeMsgs([reply(5, "Morning"), sent], [{ id: 7, role: "user", content: "Later", timestamp: at }]);
  expect(stored[1]).toMatchObject({ id: 7, rowKey: "q-abc" });
  view.rerender(thread(stored));
  expect(screen.getByText("Later")).toBe(shown);
});

it("each message says who wrote it to screen readers", () => {
  render(thread([{ id: 4, role: "user", content: "Is the report done?", timestamp: at }, reply(5, "Yes, it's in the Vault.")]));
  const [mine, theirs] = screen.getAllByRole("article");
  expect(within(mine).getByText("You")).toHaveClass("sr-only");
  expect(within(mine).getByText("Is the report done?")).toBeInTheDocument();
  expect(within(theirs).getByText(/^Nova, \d/)).toHaveClass("sr-only");
});

it("rows Load earlier added aren't trimmed while they're read; notices go with trimmed rows", () => {
  const rows = Array.from({ length: MAX_KEPT_MESSAGES + 10 }, (_, i) => ({ ...reply(i + 1, `row ${i + 1}`), timestamp: new Date(Date.parse(at) + i * 1000).toISOString() }));
  const next = { ...reply(MAX_KEPT_MESSAGES + 20, "new"), timestamp: new Date(Date.parse(at) + 3_600_000).toISOString() };
  // While the owner reads them the chat keeps everything (chief-chat.tsx readingEarlier); back at the newest, it trims.
  expect(mergeMsgs(rows, [next], Number.POSITIVE_INFINITY)).toHaveLength(MAX_KEPT_MESSAGES + 11);
  const trimmed = mergeMsgs(rows, [next]);
  expect(trimmed).toHaveLength(MAX_KEPT_MESSAGES);
  expect(trimmed[0].content).toBe("row 12");
  const notice = (id: string, seconds: number): ChatNotice => ({ id, at: Date.parse(at) / 1000 + seconds, text: id, source: "notice" });
  expect(trimNotices([notice("old", 5), notice("kept", 20)], trimmed).map((n) => n.id)).toEqual(["kept"]);
  // A chat that isn't full keeps them all, but never more than the notice limit.
  expect(trimNotices([notice("before the first row", -60)], rows.slice(0, 3))).toHaveLength(1);
  expect(trimNotices(Array.from({ length: 300 }, (_, i) => notice(`n${i}`, i)), rows.slice(0, 3))).toHaveLength(200);
});
