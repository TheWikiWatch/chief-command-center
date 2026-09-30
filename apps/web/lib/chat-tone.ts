import type { ChatMessage } from "@/lib/types";

export type ChatTone = "reply" | "kanban" | "system" | "compaction" | "origin" | "tool" | "error";

export function chatTone(message: ChatMessage): ChatTone {
  const body = String(message.content || "").trim();
  if (message.role === "tool") return "tool";
  if (message.role === "assistant" && message.tools?.length && !body) return "tool";
  if (message.role === "system") return "error";
  const t = String(message.content || "").trim();
  if (/^\[kanban\]/i.test(t)) return "kanban";
  if (/^\[System note/i.test(t)) return "system";
  if (/^\[CONTEXT COMPACTION/i.test(t)) return "compaction";
  if (/^Gateway message origin/i.test(t)) return "origin";
  return "reply";
}

export function isMachineNote(tone: ChatTone) {
  return tone !== "reply";
}

/** Index of the latest user message, or -1. */
export function lastUserIndex(messages: ChatMessage[]) {
  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") lastUser = i;
  }
  return lastUser;
}

/**
 * True when the latest user message has no assistant reply without tools after it.
 * That is the "Chief is thinking" condition for an in-flight turn.
 */
export function awaitingReply(messages: ChatMessage[]) {
  const lastUser = lastUserIndex(messages);
  if (lastUser < 0) return false;
  for (let i = lastUser + 1; i < messages.length; i++) {
    const msg = messages[i];
    const tone = chatTone(msg);
    if (tone === "error") return false;
    // Any assistant message with visible text ends the wait — Hermes often
    // attaches tools[] on the same bubble as the spoken reply.
    const body = String(msg.content || "").trim();
    if (msg.role === "assistant" && body && (tone === "reply" || tone === "tool")) return false;
  }
  return true;
}

/**
 * Orphaned ask: last user message with no assistant/tool activity after it.
 * After a gateway crash mid-turn the transcript often ends on the user message
 * while generating=false — that must not keep the thinking chrome forever.
 */
export function orphanedUserAsk(messages: ChatMessage[]) {
  const lastUser = lastUserIndex(messages);
  if (lastUser < 0) return false;
  for (let i = lastUser + 1; i < messages.length; i++) {
    const role = messages[i].role;
    if (role === "assistant" || role === "tool") return false;
  }
  return true;
}

/**
 * Should the dashboard show thinking chrome?
 * - Always when busy / generating / approval.
 * - Mid-turn (tools already landed) via awaitingReply even if generating flickers false.
 * - Brand-new orphan ask only while recent (crash orphans go quiet after the window).
 */
export function shouldShowThinking(
  messages: ChatMessage[],
  opts: { busy?: boolean; generating?: boolean; approval?: boolean; orphanMaxAgeMs?: number; now?: number } = {},
) {
  if (opts.approval || opts.busy || opts.generating) return true;
  if (!awaitingReply(messages)) return false;
  // Mid-turn: tools/stubs landed, final text not yet — keep chrome up.
  if (!orphanedUserAsk(messages)) return true;
  // Orphan user ask with idle bridge: do NOT keep Thinking up. The chat UI
  // uses pendingReply for the short race between send and generating=true.
  return false;
}

export function notePreview(content: string) {
  const line = content.split(/\r?\n/).find((s) => s.trim()) || content;
  return line.replace(/^\[(?:kanban|System note[^\]]*|CONTEXT COMPACTION[^\]]*)\]\s*/i, "").trim() || line;
}
