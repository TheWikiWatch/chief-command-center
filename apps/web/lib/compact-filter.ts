import type { ChatMessage } from "@/lib/types";
import { chatTone, isMachineNote } from "@/lib/chat-tone";

/** Messages eligible for the chat scroller (role allow-list). */
export function transcriptMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "tool" || m.role === "system",
  );
}

/** Compact chat: hide tool/system/kanban/compaction/origin scaffolding; keep errors + replies. */
export function visibleMessages(messages: ChatMessage[], compactChat: boolean): ChatMessage[] {
  const base = transcriptMessages(messages);
  if (!compactChat) return base;
  return base.filter((m) => {
    const tone = chatTone(m);
    // Errors and the results of background work stay: they are outcomes, not scaffolding.
    if (tone === "error" || tone === "background") return true;
    return !isMachineNote(tone);
  });
}
