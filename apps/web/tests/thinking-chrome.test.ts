import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/types";
import {
  computeThinkingChrome,
  messageTimeMs,
  shouldClearPendingReply,
  uniqueToolNames,
} from "@/lib/thinking-chrome";

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "role" | "content">): ChatMessage {
  return {
    id: partial.id ?? 1,
    tools: partial.tools ?? [],
    ...partial,
  } as ChatMessage;
}

describe("messageTimeMs", () => {
  it("parses epoch seconds from bridge", () => {
    expect(messageTimeMs(1789792323.413553)).toBeCloseTo(1789792323413.553, 0);
  });
  it("parses ISO from optimistic send", () => {
    const iso = "2026-09-19T04:32:03.000Z";
    expect(messageTimeMs(iso)).toBe(Date.parse(iso));
  });
});

describe("computeThinkingChrome", () => {
  it("shows during pendingReply even if disconnected briefly", () => {
    expect(
      computeThinkingChrome({
        connected: false,
        pendingReply: true,
        busy: false,
        generating: false,
        approval: false,
        messages: [msg({ role: "user", content: "hi" })],
      }),
    ).toBe(true);
  });

  it("hides when idle orphan and not pending (post-crash Status?)", () => {
    expect(
      computeThinkingChrome({
        connected: true,
        pendingReply: false,
        busy: false,
        generating: false,
        approval: false,
        messages: [msg({ role: "user", content: "Status?", timestamp: String(Date.now() / 1000 - 120) })],
      }),
    ).toBe(false);
  });

  it("shows first-send race via pendingReply before generating flips", () => {
    expect(
      computeThinkingChrome({
        connected: true,
        pendingReply: true,
        busy: false,
        generating: false,
        approval: false,
        messages: [msg({ role: "user", content: "hi", timestamp: new Date().toISOString() })],
      }),
    ).toBe(true);
  });
});

describe("shouldClearPendingReply", () => {
  it("clears when assistant text arrived", () => {
    expect(
      shouldClearPendingReply({
        pendingReply: true,
        generating: false,
        busy: false,
        messages: [
          msg({ role: "user", content: "hi", id: 1 }),
          msg({ role: "assistant", content: "yo", id: 2 }),
        ],
      }),
    ).toBe(true);
  });

  it("clears after idle timeout when generating never starts", () => {
    const now = Date.now();
    expect(
      shouldClearPendingReply({
        pendingReply: true,
        generating: false,
        busy: false,
        nowMs: now,
        idleTimeoutMs: 20_000,
        messages: [
          msg({
            role: "user",
            content: "Status?",
            id: 1,
            timestamp: new Date(now - 25_000).toISOString(),
          }),
        ],
      }),
    ).toBe(true);
  });

  it("keeps pending during short race window", () => {
    const now = Date.now();
    expect(
      shouldClearPendingReply({
        pendingReply: true,
        generating: false,
        busy: false,
        nowMs: now,
        idleTimeoutMs: 20_000,
        messages: [
          msg({
            role: "user",
            content: "hi",
            id: 1,
            timestamp: new Date(now - 5_000).toISOString(),
          }),
        ],
      }),
    ).toBe(false);
  });
});

describe("uniqueToolNames", () => {
  it("dedupes duplicate tool chips (kanban_show, kanban_show)", () => {
    expect(uniqueToolNames(["kanban_show", "kanban_show", " "])).toEqual(["kanban_show"]);
  });
});
