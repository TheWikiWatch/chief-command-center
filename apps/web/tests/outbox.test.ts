import { afterEach, expect, it } from "vitest";

import { deleteFiles, expired, getFile, loadOutbox, OUTBOX_KEY, OUTBOX_TTL_MS, putFile, retryable, saveOutbox, type QueuedSend } from "@/lib/outbox";

afterEach(() => localStorage.clear());

const item = (over: Partial<QueuedSend> = {}): QueuedSend => ({ id: "a", text: "hi", files: [], at: Date.now(), attempts: 0, ...over });

it("keeps the queue across a reload and ignores anything malformed", () => {
  saveOutbox([item(), item({ id: "b" })]);
  expect(loadOutbox().map((q) => q.id)).toEqual(["a", "b"]);
  localStorage.setItem(OUTBOX_KEY, JSON.stringify([{ id: 1 }, item({ id: "c" }), null]));
  expect(loadOutbox().map((q) => q.id)).toEqual(["c"]);
  localStorage.setItem(OUTBOX_KEY, "not json");
  expect(loadOutbox()).toEqual([]);
  saveOutbox([]);
  expect(localStorage.getItem(OUTBOX_KEY)).toBeNull();
});

it("a message expires after a day", () => {
  const now = Date.now();
  expect(expired(item({ at: now - OUTBOX_TTL_MS + 1000 }), now)).toBe(false);
  expect(expired(item({ at: now - OUTBOX_TTL_MS - 1 }), now)).toBe(true);
});

it("retries network and gateway failures, not messages refused with a reason", () => {
  expect(retryable(new Error("Request timed out or was cancelled."))).toBe(true);
  expect(retryable(Object.assign(new Error("bridge unreachable"), { status: 502 }))).toBe(true);
  expect(retryable(Object.assign(new Error("offline"), { status: 0 }))).toBe(true);
  expect(retryable(Object.assign(new Error("Message is empty."), { status: 400 }))).toBe(false);
  expect(retryable(Object.assign(new Error("too large"), { status: 413 }))).toBe(false);
  expect(retryable(Object.assign(new Error("unauthorized"), { status: 401 }))).toBe(false);
});

it("holds files in memory where IndexedDB is unavailable", async () => {
  const blob = new Blob(["photo"], { type: "image/jpeg" });
  await putFile("a:0", blob);
  expect(await getFile("a:0")).toBe(blob);
  await deleteFiles(["a:0"]);
  expect(await getFile("a:0")).toBeNull();
});
