"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { sendToChief, type OutboundAttachment } from "@/lib/bridge";
import { deleteFiles, expired, getFile, loadOutbox, putFile, retryable, saveOutbox, type QueuedSend } from "@/lib/outbox";
import type { ChatAttachment, ChatMessage } from "@/lib/types";
import { blobToDataUrl } from "@/lib/voice-client";
import { assistantName } from "@/lib/identity";

const RETRY_MS = 15_000;

export type QueueFile = { name: string; mime: string; blob: Blob };

const kindOf = (mime: string): ChatAttachment["kind"] =>
  mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "file";

function gone(message: string) {
  return Object.assign(new Error(message), { status: 410 });
}

/**
 * Messages waiting for Chief (lib/outbox.ts): kept across reloads, sent in order once `ready`, retried
 * every 15s while the network fails. `onDelivered` gets the item and its image previews (the caller
 * owns them from then on); `onDropped` gets one that expired or was refused.
 */
export function useOutbox({
  ready,
  onDelivered,
  onDropped,
}: {
  ready: boolean;
  onDelivered: (item: QueuedSend, previews: string[]) => void;
  onDropped: (item: QueuedSend, reason: string) => void;
}) {
  const [queued, setQueued] = useState<QueuedSend[]>([]);
  const queueRef = useRef<QueuedSend[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const previewRef = useRef(previews);
  previewRef.current = previews;
  const flushing = useRef(false);
  const [retryTick, setRetryTick] = useState(0);
  const callbacks = useRef({ onDelivered, onDropped });
  callbacks.current = { onDelivered, onDropped };

  const commit = useCallback((next: QueuedSend[]) => {
    queueRef.current = next;
    setQueued(next);
    saveOutbox(next);
  }, []);

  // After a reload: the queue from storage, with previews of its images rebuilt from IndexedDB.
  useEffect(() => {
    const saved = loadOutbox();
    if (!saved.length) return;
    commit(saved);
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

  /** Queue a message. `failed`: it was just tried and failed on the network, so wait before the retry. */
  const enqueue = useCallback(
    async (id: string, text: string, files: QueueFile[], failed?: string) => {
      if (queueRef.current.some((q) => q.id === id)) return;
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
      commit([...queueRef.current, { id, text, files: stored, at: now, attempts: failed ? 1 : 0, ...(failed ? { lastError: failed, nextAt: now + RETRY_MS } : {}) }]);
    },
    [commit],
  );

  /** Take a message back out of the queue (its text is returned so it can go back in the draft). */
  const cancel = useCallback(
    (id: string) => {
      const item = queueRef.current.find((q) => q.id === id);
      if (!item) return null;
      commit(queueRef.current.filter((q) => q.id !== id));
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
      for (const item of [...queueRef.current]) {
        if (!alive.current) break;
        if (!queueRef.current.some((q) => q.id === item.id)) continue; // cancelled meanwhile
        if (item.nextAt && item.nextAt > Date.now()) {
          wait = item.nextAt - Date.now(); // keep the order: nothing after it goes first
          break;
        }
        const drop = (reason: string) => {
          commit(queueRef.current.filter((q) => q.id !== item.id));
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
          const res = await sendToChief(item.text, attachments, item.id);
          if (!res.ok) throw gone(res.error || `${assistantName()} did not accept the message.`);
          commit(queueRef.current.filter((q) => q.id !== item.id));
          const urls = takePreviews(item, false);
          void deleteFiles(item.files.map((f) => f.key));
          callbacks.current.onDelivered(item, urls);
        } catch (error) {
          if (retryable(error)) {
            const reason = error instanceof Error ? error.message : `${assistantName()} is unreachable`;
            commit(queueRef.current.map((q) => (q.id === item.id ? { ...q, attempts: q.attempts + 1, lastError: reason, nextAt: Date.now() + RETRY_MS } : q)));
            wait = RETRY_MS;
            break;
          }
          drop(error instanceof Error ? error.message : `${assistantName()} did not accept the message.`);
        }
      }
      flushing.current = false;
      if (!alive.current) return;
      // Try again later after a network failure; at once if more were queued while this ran.
      if (wait) retryTimer.current = setTimeout(() => setRetryTick((n) => n + 1), wait);
      else if (queueRef.current.length) setRetryTick((n) => n + 1);
    })();
  }, [ready, queued.length, retryTick, commit, takePreviews]);

  /** Queued messages as chat bubbles (after everything else in the thread). */
  const bubbles = useMemo<ChatMessage[]>(
    () =>
      queued.map((q, i) => ({
        // Local bubble ids sit at 1e12 and up, like other not-yet-stored sends; `at` is unique per send.
        id: Math.max(q.at, 1e12) + i / 100,
        role: "user",
        content: q.text,
        timestamp: new Date(q.at).toISOString(),
        // Only what can be shown from this device: images with a local preview. Other files are named.
        attachments: q.files.filter((f) => previews[f.key]).map((f) => ({ path: previews[f.key], name: f.name, kind: kindOf(f.mime), mime: f.mime })),
        delivery: "queued",
        queueId: q.id,
        queueNote: q.lastError,
        queueFiles: q.files.filter((f) => !previews[f.key]).map((f) => f.name),
      })),
    [queued, previews],
  );

  return { queued, bubbles, enqueue, cancel };
}
