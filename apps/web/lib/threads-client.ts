import { requestJson } from "@/lib/request";

/** Separate conversations with the chief (bridge contract chief.threads.v1). "main" is the main chat. */
export type ChatThread = {
  id: string;
  title: string;
  /** The owner named it (otherwise the title is Hermes's for its latest conversation). */
  named: boolean;
  created: number;
  archived: boolean;
  /** Epoch seconds of its last message. */
  lastActivity: number;
  working: boolean;
  question: boolean;
  approval: boolean;
};

const post = <T>(path: string, body: unknown) =>
  requestJson<T>(`/api/bridge/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 20_000);
type One = { ok: boolean; error?: string; thread?: ChatThread };

export const threadsApi = {
  list: () => requestJson<{ ok: boolean; error?: string; threads: ChatThread[] }>("/api/bridge/threads", { cache: "no-store" }, 10_000),
  create: (title = "") => post<One>("threads", { title }),
  rename: (thread: string, title: string) => post<One>("threads/rename", { thread, title }),
  archive: (thread: string, archived = true) => post<One>("threads/archive", { thread, archived }),
  /** A fresh start: the chief begins a new conversation in the thread; the earlier one stays as history. */
  fresh: (thread: string) => post<{ ok: boolean; error?: string; code?: string }>("threads/fresh", { thread }),
};

/** Per device: the thread the chat shows, and when each thread was last seen (for unread dots). */
const CURRENT_KEY = "chief-chat-thread";
const SEEN_KEY = "chief-thread-seen";

export function readCurrentThread(): string {
  try {
    return localStorage.getItem(CURRENT_KEY) || "main";
  } catch {
    return "main";
  }
}
export function writeCurrentThread(id: string) {
  try {
    localStorage.setItem(CURRENT_KEY, id);
  } catch {
    /* private mode */
  }
}
export function readSeen(): Record<string, number> {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") as Record<string, number>;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
export function markSeen(id: string, at = Date.now() / 1000) {
  try {
    const seen = readSeen();
    seen[id] = Math.max(seen[id] || 0, at);
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    /* private mode */
  }
}
