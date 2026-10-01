"use client";

import { useSyncExternalStore } from "react";

import { chatTone } from "@/lib/chat-tone";
import type { ChatMessage } from "@/lib/types";

/**
 * Follow-up safety net (PLAN-2026-09-23 §2). Two kinds of reminder, kept per device:
 * - "finished": a specialist finished a job and the chief has not said anything about it yet.
 * - "promise": The chief said it would check back and has not posted since.
 * Each waits quietly until its deadline and disappears the moment the chief follows up.
 */
export type FollowupKind = "finished" | "promise";
export type Followup = {
  id: string;
  kind: FollowupKind;
  /** Bot display name (finished). */
  who?: string;
  whoId?: string;
  /** Job title (finished) or the sentence the chief promised in (promise). */
  title: string;
  createdAt: number;
  dueAt: number;
  /** Newest chat message id when the reminder started; only later messages count as a follow-up. */
  afterId: number | null;
  shown: boolean;
};

export const FINISHED_WAIT_MS = 3 * 60_000;
export const PROMISE_WAIT_MS = 20 * 60_000;
const KEY = "chief-followups";
const MAX_AGE_MS = 24 * 60 * 60_000;

const listeners = new Set<() => void>();
let cacheRaw: string | null | undefined;
let cache: Followup[] = [];

export function readFollowups(): Followup[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    raw = null;
  }
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    try {
      const parsed = JSON.parse(raw || "[]");
      cache = Array.isArray(parsed) ? parsed.filter((f) => f && typeof f.id === "string" && Date.now() - f.createdAt < MAX_AGE_MS) : [];
    } catch {
      cache = [];
    }
  }
  return cache;
}

function write(next: Followup[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    cacheRaw = undefined;
    cache = next;
  }
  for (const fn of listeners) fn();
}

export function updateFollowups(change: (items: Followup[]) => Followup[]) {
  const before = readFollowups();
  const next = change(before);
  if (next !== before) write(next);
}

export function addFollowup(item: Omit<Followup, "shown" | "afterId"> & { afterId?: number | null }) {
  updateFollowups((items) => [...items.filter((f) => f.id !== item.id), { afterId: null, ...item, shown: false }]);
}

export function removeFollowup(id: string) {
  updateFollowups((items) => (items.some((f) => f.id === id) ? items.filter((f) => f.id !== id) : items));
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

const EMPTY: Followup[] = [];
export function useFollowups(): Followup[] {
  return useSyncExternalStore(subscribe, readFollowups, () => EMPTY);
}

/* ---------------------------------------------------------------- rules (pure, tested) */

const stable = (m: ChatMessage) => (m.id || 0) > 0 && (m.id || 0) < 1e12;
const isReply = (m: ChatMessage) => m.role === "assistant" && chatTone(m) === "reply" && !!String(m.content || "").trim();

export function newestId(messages: ChatMessage[]) {
  let max = 0;
  for (const m of messages) if (stable(m) && m.id > max) max = m.id;
  return max;
}

/** Has the chief followed up on this reminder, judging only by messages after it started? */
export function followedUp(item: Followup, messages: ChatMessage[]): boolean {
  if (item.afterId === null) return false;
  const later = messages.filter((m) => stable(m) && m.id > (item.afterId as number));
  if (item.kind === "promise") return later.some(isReply);
  // A kanban completion note followed by any reply from the chief means it picked it up.
  const noteAt = later.findIndex((m) => chatTone(m) === "kanban");
  if (noteAt >= 0 && later.slice(noteAt + 1).some(isReply)) return true;
  // Or the chief mentions the bot by name.
  const name = (item.who || "").trim();
  if (!name) return false;
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  return later.some((m) => isReply(m) && re.test(String(m.content)));
}

const PROMISE = /\b(?:I'?ll|I will|I'm going to|let me)\s+(?:check back|follow up|report back|circle back|get back to you|come back to (?:this|you)|ping you|update you|let you know (?:when|once|as soon as))\b/i;

/** The sentence in which the chief promised to check back, if it did. */
export function detectPromise(text: string): string | null {
  const body = String(text || "");
  const m = PROMISE.exec(body);
  if (!m) return null;
  const start = Math.max(body.lastIndexOf(".", m.index), body.lastIndexOf("\n", m.index), body.lastIndexOf("!", m.index), body.lastIndexOf("?", m.index)) + 1;
  const endHit = body.slice(m.index).search(/[.!?\n]/);
  const end = endHit < 0 ? body.length : m.index + endHit + 1;
  const sentence = body.slice(start, end).replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}
