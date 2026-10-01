import type { ChatMessage } from "@/lib/types";
import { awaitingReply, shouldShowThinking } from "@/lib/chat-tone";

/** Parse bridge epoch seconds/ms or ISO timestamps to epoch ms. */
export function messageTimeMs(raw: string | number | undefined | null): number {
  if (raw == null || raw === "") return NaN;
  if (typeof raw === "number") return raw > 1e12 ? raw : raw * 1000;
  const s = String(raw).trim();
  if (!s) return NaN;
  if (!s.includes("T")) {
    const n = Number(s);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  }
  return Date.parse(s);
}

export type ChromeInput = {
  connected: boolean;
  pendingReply: boolean;
  busy: boolean;
  generating: boolean;
  approval: boolean;
  messages: ChatMessage[];
};

/**
 * Single source of truth for "The chief is thinking" chrome.
 * - pendingReply covers the send→generating race
 * - shouldShowThinking covers mid-turn tools + live generating
 * - idle orphan asks must NOT keep chrome up
 */
export function computeThinkingChrome(input: ChromeInput): boolean {
  const { connected, pendingReply, busy, generating, approval, messages } = input;
  if (pendingReply) return true;
  if (!connected) return false;
  return shouldShowThinking(messages, {
    busy: busy || pendingReply,
    generating,
    approval,
  });
}

export type PendingClearInput = {
  pendingReply: boolean;
  messages: ChatMessage[];
  generating: boolean;
  busy: boolean;
  nowMs?: number;
  idleTimeoutMs?: number;
};

/** Whether pendingReply should clear on this tick. */
export function shouldClearPendingReply(input: PendingClearInput): boolean {
  if (!input.pendingReply) return false;
  if (!awaitingReply(input.messages)) return true;
  if (input.generating || input.busy) return false;
  const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
  const t = messageTimeMs(lastUser?.timestamp as string | number | undefined);
  if (Number.isNaN(t)) return false;
  const now = input.nowMs ?? Date.now();
  const timeout = input.idleTimeoutMs ?? 20_000;
  return now - t > timeout;
}

export function uniqueToolNames(tools: string[] | undefined): string[] {
  if (!tools?.length) return [];
  return Array.from(new Set(tools.map((t) => String(t).trim()).filter(Boolean)));
}
