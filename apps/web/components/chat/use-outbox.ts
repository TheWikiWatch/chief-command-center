"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { sendToChief, type OutboundAttachment } from "@/lib/bridge";
import { deleteFiles, expired, getFile, loadOutbox, putFile, queuedThread, retryable, saveOutbox, timedOut, type QueuedSend } from "@/lib/outbox";
import type { ChatAttachment, ChatMessage } from "@/lib/types";
import { blobToDataUrl } from "@/lib/voice-client";
import { assistantName } from "@/lib/identity";

const RETRY_MS = 15_000;
/** Timeouts after which an upload waits for the owner instead of trying again on its own. */
const HOLD_AFTER_TIMEOUTS = 2;

export type QueueFile = { name: string; mime: string; blob: Blob };
/** A send that just failed on the network, so the queue waits before its retry. */
export type QueueFailure = { reason: string; timedOut: boolean };

// The page's queue, not one chat's: the chat remounts per thread, and a send still on its way from the thread just
// left can queue (or finish) after the next one has mounted. Every chat works on this list and follows the others'.
const queue = { current: [] as QueuedSend[] };
const followers = new Set<(list: QueuedSend[]) => void>();

const kindOf = (mime: string): ChatAttachment["kind"] =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";

function gone(message: string) {
  return Object.assign(new Error(message), { status: 410 });
}

/**
 * Messages waiting for the chief (lib/outbox.ts): kept across reloads, sent in order once `ready`, each to the thread
 * it was written in, retried every 15s while the network fails. An upload that timed out twice waits for the owner's
 * Retry or Cancel. Only `thread`'s own show as bubbles here. `onDelivered` gets the item and its image previews (the
 * caller owns them from then on); `onDropped` gets one that expired or was refused.
 */
export function useOutbox({
  thread,
  ready,
  onDelivered,
  onDropped,
}: {
  thread: string;
  ready: boolean;
  onDelivered: (item: QueuedSend, previews: string[]) => void;
  onDropped: (item: QueuedSend, reason: string) => void;
}) {
  const [queued, setQueued] = useState<QueuedSend[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const previewRef = useRef(previews);
  previewRef.current = previews;
  const flushing = useRef(false);
  const [retryTick, setRetryTick] = useState(0);
  const callbacks = useRef({ onDelivered, onDropped });
  callbacks.current = { onDelivered, onDropped };

  const commit = useCallback((next: QueuedSend[]) => {
    queue.current = next;
    saveOutbox(next);
    for (const follow of followers) follow(next);
  }, []);
  useEffect(() => {
    followers.add(setQueued);
    return () => {
      followers.delete(setQueued);
    };
  }, []);

  // On mount (a reload, another thread): the queue from storage, with previews of its images rebuilt from IndexedDB.
  useEffect(() => {
    const saved = loadOutbox();
    commit(saved);
    if (!saved.length) return;
    let alive = true;
    void (async () => {
      const built: Record<string, string> = {};
      for (const f of saved.flatMap((q) => q.files)) {
        if (!f.mime.startsWith("image/")) continue;
        const blob = await getFile(f.key);
        if (blob) built[f.key] = URL.createObjectURL(blob);
      }
      if (alive) setPreviews((p) => ({ ...p, ...built }));
      else for (const url of Object.values(built)) URL.revokeObjectURL(url);
    })();
    return () => {
      alive = false;
    };
  }, [commit]);

  useEffect(() => () => {
    for (const url of Object.values(previewRef.current)) URL.revokeObjectURL(url);
  }, []);

  /** Take previews out of the hook: revoked when `release`, otherwise handed to the caller. */
  const takePreviews = useCallback((item: QueuedSend, release: boolean) => {
    const urls = item.files.map((f) => previewRef.current[f.key]).filter((u): u is string => !!u);
    if (release) for (const url of urls) URL.revokeObjectURL(url);
    setPreviews((p) => {
      const next = { ...p };
      for (const f of item.files) delete next[f.key];
      return next;
    });
    return urls;
  }, []);

  /** Queue a message written in this thread. `failed`: it was just tried and failed on the network, so wait before the retry. */
  const enqueue = useCallback(
    async (id: string, text: string, files: QueueFile[], failed?: QueueFailure) => {
      if (queue.current.some((q) => q.id === id)) return;
      const stored = [];
      const made: Record<string, string> = {};
      for (const [i, f] of files.entries()) {
        const key = `${id}:${i}`;
        await putFile(key, f.blob);
        stored.push({ key, name: f.name, mime: f.mime, size: f.blob.size });
        if (f.mime.startsWith("image/")) made[key] = URL.createObjectURL(f.blob);
      }
      setPreviews((p) => ({ ...p, ...made }));
      const now = Date.now();
      const tried = failed ? { lastError: failed.reason, nextAt: now + RETRY_MS, timeouts: failed.timedOut && stored.length ? 1 : 0 } : {};
      commit([...queue.current, { id, text, files: stored, at: now, attempts: failed ? 1 : 0, thread, ...tried }]);
    },
    [commit, thread],
  );

  /** Take a message back out of the queue (its text is returned so it can go back in the draft). */
  const cancel = useCallback(
    (id: string) => {
      const item = queue.current.find((q) => q.id === id);
      if (!item) return null;
      commit(queue.current.filter((q) => q.id !== id));
      takePreviews(item, true);
      void deleteFiles(item.files.map((f) => f.key));
      return item;
    },
    [commit, takePreviews],
  );

  // The flush loop commits as it goes (which re-runs the effect below), so it stops only on unmount.
  const alive = useRef(true);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(retryTimer.current);
    };
  }, []);

  useEffect(() => {
    if (!ready || !queued.length || flushing.current) return;
    flushing.current = true;
    clearTimeout(retryTimer.current);
    void (async () => {
      let wait = 0;
      // A held upload waits for the owner's Retry or Cancel, and keeps the order: nothing after it goes first.
      let held = false;
      for (const item of [...queue.current]) {
        if (!alive.current) break;
        if (!queue.current.some((q) => q.id === item.id)) continue; // cancelled meanwhile
        if (item.held) {
          held = true;
          break;
        }
        if (item.nextAt && item.nextAt > Date.now()) {
          wait = item.nextAt - Date.now(); // keep the order: nothing after it goes first
          break;
        }
        const drop = (reason: string) => {
          commit(queue.current.filter((q) => q.id !== item.id));
          takePreviews(item, true);
          void deleteFiles(item.files.map((f) => f.key));
          callbacks.current.onDropped(item, reason);
        };
        if (expired(item)) {
          drop("It waited more than a day, so it was not sent.");
          continue;
        }
        try {
          const attachments: OutboundAttachment[] = [];
          for (const f of item.files) {
            const blob = await getFile(f.key);
            if (!blob) throw gone(`${f.name} was lost when the app reloaded.`);
            attachments.push({ name: f.name, mime: f.mime, data_url: await blobToDataUrl(blob) });
          }
          // To the thread it was written in, whichever thread is open now.
          const res = await sendToChief(item.text, attachments, item.id, queuedThread(item));
          if (!res.ok) throw gone(res.error || `${assistantName()} did not accept the message.`);
          commit(queue.current.filter((q) => q.id !== item.id));
          const urls = takePreviews(item, false);
          void deleteFiles(item.files.map((f) => f.key));
          callbacks.current.onDelivered(item, urls);
        } catch (error) {
          if (retryable(error)) {
            const reason = error instanceof Error ? error.message : `${assistantName()} is unreachable`;
            // Sending the same files again after two timeouts would most likely time out again, every 15 s for a day.
            const timeouts = (item.timeouts || 0) + (item.files.length && timedOut(error) ? 1 : 0);
            held = timeouts >= HOLD_AFTER_TIMEOUTS;
            commit(queue.current.map((q) => (q.id === item.id ? { ...q, attempts: q.attempts + 1, lastError: reason, timeouts, held, nextAt: held ? undefined : Date.now() + RETRY_MS } : q)));
            if (!held) wait = RETRY_MS;
            break;
          }
          drop(error instanceof Error ? error.message : `${assistantName()} did not accept the message.`);
        }
      }
      flushing.current = false;
      if (!alive.current || held) return;
      // Try again later after a network failure; at once if more were queued while this ran.
      if (wait) retryTimer.current = setTimeout(() => setRetryTick((n) => n + 1), wait);
      else if (queue.current.length) setRetryTick((n) => n + 1);
    })();
  }, [ready, queued.length, retryTick, commit, takePreviews]);

  /** This thread's queued messages as chat bubbles (after everything else in the thread). */
  const bubbles = useMemo<ChatMessage[]>(
    () =>
      queued
        .filter((q) => queuedThread(q) === thread)
        .map((q, i) => ({
          // Local bubble ids sit at 1e12 and up, like other not-yet-stored sends; `at` is unique per send.
          id: Math.max(q.at, 1e12) + i / 100,
          // The row stays the same one when it goes out and when its stored copy lands (no second entrance).
          rowKey: `q-${q.id}`,
          role: "user",
          content: q.text,
          timestamp: new Date(q.at).toISOString(),
          // Only what can be shown from this device: images with a local preview. Other files are named.
          attachments: q.files.filter((f) => previews[f.key]).map((f) => ({ path: previews[f.key], name: f.name, kind: kindOf(f.mime), mime: f.mime })),
          delivery: "queued",
          queueId: q.id,
          queueNote: q.lastError,
          queueHeld: q.held,
          queueFiles: q.files.filter((f) => !previews[f.key]).map((f) => f.name),
        })),
    [queued, previews, thread],
  );

  /** Try every waiting message now instead of after the retry pause ("Retry now" under a failed send, Retry under a
   * held upload, which then gets two more tries). */
  const retryNow = useCallback(() => {
    commit(queue.current.map((q) => ({ ...q, nextAt: undefined, held: false, timeouts: 0 })));
    clearTimeout(retryTimer.current);
    setRetryTick((n) => n + 1);
  }, [commit]);

  return { queued, bubbles, enqueue, cancel, retryNow };
}
