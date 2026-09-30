import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/types";
import { visibleMessages } from "@/lib/compact-filter";

function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, "role" | "content">): ChatMessage {
  return { id: partial.id ?? 1, tools: partial.tools ?? [], ...partial } as ChatMessage;
}

describe("Compact chat filter", () => {
  const mix = [
    msg({ role: "user", content: "hi", id: 1 }),
    msg({ role: "assistant", content: "hello", id: 2 }),
    msg({ role: "assistant", content: "", tools: ["kanban_show"], id: 3 }),
    msg({ role: "user", content: "[System note: x]", id: 4 }),
    msg({ role: "user", content: "[kanban] task", id: 5 }),
    msg({ role: "system", content: "Send failed.", id: 6 }),
  ];

  it("shows everything when compact off", () => {
    expect(visibleMessages(mix, false).map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("hides tool/system/kanban scaffolding but keeps replies and errors", () => {
    expect(visibleMessages(mix, true).map((m) => m.id)).toEqual([1, 2, 6]);
  });
});
