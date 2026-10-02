import { describe, expect, it } from "vitest";

import { buildRows } from "@/components/chat/thread";
import type { ChatMessage } from "@/lib/types";

const at = (iso: string) => String(new Date(iso).getTime() / 1000);

describe("thread rows", () => {
  it("shows each day's separator once, even when a row's time steps back to an earlier day", () => {
    const messages: ChatMessage[] = [
      { id: 1, role: "user", content: "a", timestamp: at("2026-10-01T09:00:00") },
      { id: 2, role: "assistant", content: "b", timestamp: at("2026-10-02T09:00:00") },
      // Dated late by the gateway: back on the first day.
      { id: 3, role: "assistant", content: "c", timestamp: at("2026-10-01T23:00:00") },
      { id: 4, role: "user", content: "d", timestamp: at("2026-10-02T10:00:00") },
    ];
    const days = buildRows(messages).filter((r) => r.kind === "day");
    expect(days).toHaveLength(2);
    expect(new Set(days.map((d) => d.key)).size).toBe(days.length);
    const keys = buildRows(messages).map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
