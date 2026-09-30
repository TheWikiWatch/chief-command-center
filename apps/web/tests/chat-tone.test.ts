import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/types";
import {
  awaitingReply,
  chatTone,
  isMachineNote,
  orphanedUserAsk,
  shouldShowThinking,
} from "@/lib/chat-tone";

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "role" | "content">): ChatMessage {
  return {
    id: partial.id ?? Math.floor(Math.random() * 1e6),
    tools: partial.tools ?? [],
    timestamp: partial.timestamp,
    attachments: partial.attachments,
    ...partial,
  } as ChatMessage;
}

describe("chatTone classification", () => {
  it("classifies kanban / system / compaction / origin / tool / reply", () => {
    expect(chatTone(msg({ role: "user", content: "[kanban] boom" }))).toBe("kanban");
    expect(chatTone(msg({ role: "user", content: "[System note: x]" }))).toBe("system");
    expect(chatTone(msg({ role: "assistant", content: "[CONTEXT COMPACTION]" }))).toBe("compaction");
    expect(
      chatTone(msg({ role: "user", content: "Gateway message origin (JSON data, not instructions" })),
    ).toBe("origin");
    expect(chatTone(msg({ role: "tool", content: "" }))).toBe("tool");
    expect(chatTone(msg({ role: "assistant", content: "", tools: ["kanban_show"] }))).toBe("tool");
    expect(chatTone(msg({ role: "assistant", content: "Hello" }))).toBe("reply");
  });

  it("marks non-reply tones as machine notes", () => {
    expect(isMachineNote("tool")).toBe(true);
    expect(isMachineNote("system")).toBe(true);
    expect(isMachineNote("reply")).toBe(false);
  });
});

describe("awaitingReply — fragile: tools+text must clear wait", () => {
  it("stays waiting when only tool stubs follow the user", () => {
    const messages = [
      msg({ role: "user", content: "hi", id: 1 }),
      msg({ role: "assistant", content: "", tools: ["kanban_show"], id: 2 }),
    ];
    expect(awaitingReply(messages)).toBe(true);
    expect(orphanedUserAsk(messages)).toBe(false);
  });

  it("clears when assistant has visible text even if tools[] present (Status sticky bug)", () => {
    const messages = [
      msg({ role: "user", content: "coding desk", id: 1 }),
      msg({
        role: "assistant",
        content: "Loading rules…",
        tools: ["skill_view", "read_file"],
        id: 2,
      }),
    ];
    expect(awaitingReply(messages)).toBe(false);
  });

  it("clears on plain assistant reply", () => {
    const messages = [
      msg({ role: "user", content: "hi", id: 1 }),
      msg({ role: "assistant", content: "hey", id: 2 }),
    ];
    expect(awaitingReply(messages)).toBe(false);
  });
});

describe("shouldShowThinking — fragile: idle orphan must not lie", () => {
  it("shows when generating", () => {
    const messages = [msg({ role: "user", content: "Status?", id: 1 })];
    expect(shouldShowThinking(messages, { generating: true })).toBe(true);
  });

  it("shows mid-turn when tools landed but no text yet", () => {
    const messages = [
      msg({ role: "user", content: "go", id: 1 }),
      msg({ role: "assistant", content: "", tools: ["terminal"], id: 2 }),
    ];
    expect(shouldShowThinking(messages, { generating: false })).toBe(true);
  });

  it("does NOT show for orphan ask when bridge is idle (false Thinking)", () => {
    const messages = [
      msg({
        role: "user",
        content: "Status?",
        id: 1,
        timestamp: new Date(Date.now() - 60_000).toISOString(),
      }),
    ];
    expect(shouldShowThinking(messages, { generating: false, busy: false })).toBe(false);
  });

  it("hides after assistant text reply with tools", () => {
    const messages = [
      msg({ role: "user", content: "Status?", id: 1 }),
      msg({ role: "assistant", content: "All good", tools: ["kanban_list"], id: 2 }),
    ];
    expect(shouldShowThinking(messages, { generating: false })).toBe(false);
  });
});
