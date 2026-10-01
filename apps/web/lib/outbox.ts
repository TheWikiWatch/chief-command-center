"use client";

/**
 * Messages waiting for the chief (PLAN-2026-09-29 phase 3). A send made while it is unreachable, or one
 * that failed on the network, waits here and goes out in order when it is back, with the same
 * client id, so a send that timed out after reaching it is not delivered twice (the bridge drops
 * repeats of an id for 24 hours). Text survives a reload in localStorage; files in IndexedDB (kept in
 * memory only where IndexedDB is unavailable). A queued message expires after 24 hours.
 */
export type QueuedFile = { key: string; name: string; mime: string; size: number };
export type QueuedSend = {
  id: string;
  text: string;
  files: QueuedFile[];
  at: number;
  attempts: number;
  lastError?: string;
  /** Not before this time (ms): set after a failed attempt, so a retry doesn't hammer a dead network. */
  nextAt?: number;
};

export const OUTBOX_KEY = "chief-outbox";
export const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;
const DB = "chief-outbox";
const STORE = "files";

export function loadOutbox(): QueuedSend[] {
  try {
    const raw = JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]");
    return Array.isArray(raw)
      ? raw.filter((q): q is QueuedSend => !!q && typeof q.id === "string" && typeof q.text === "string" && Array.isArray(q.files) && typeof q.at === "number")
      : [];
  } catch {
    return [];
  }
}

export function saveOutbox(list: QueuedSend[]) {
  try {
    if (list.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(list));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch {
    /* private mode: the queue lives until the page closes */
  }
}

export const expired = (q: QueuedSend, now = Date.now()) => now - q.at > OUTBOX_TTL_MS;

/**
 * Worth trying again later: the network or the gateway, not the message. A rejection with a reason
 * (400 "Message is empty", 413 too large, 401) would fail the same way again.
 */
export function retryable(error: unknown): boolean {
  const status = (error as { status?: unknown })?.status;
  if (typeof status === "number") return status === 0 || status === 408 || status === 429 || status >= 500;
  return true;
}

// Files: IndexedDB when there is one, otherwise this page's memory.
const memory = new Map<string, Blob>();

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const req = run(tx.objectStore(STORE));
      tx.oncomplete = () => {
        db.close();
        resolve(req ? req.result : undefined);
      };
      tx.onerror = tx.onabort = () => {
        db.close();
        resolve(undefined);
      };
    } catch {
      db.close();
      resolve(undefined);
    }
  });
}

export async function putFile(key: string, blob: Blob): Promise<void> {
  memory.set(key, blob);
  await withStore("readwrite", (store) => store.put(blob, key));
}

export async function getFile(key: string): Promise<Blob | null> {
  const held = memory.get(key);
  if (held) return held;
  const found = await withStore<Blob>("readonly", (store) => store.get(key));
  return found instanceof Blob ? found : null;
}

export async function deleteFiles(keys: string[]): Promise<void> {
  for (const key of keys) memory.delete(key);
  if (!keys.length) return;
  await withStore("readwrite", (store) => {
    for (const key of keys) store.delete(key);
  });
}
