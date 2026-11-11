// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";

import { POST } from "@/app/api/bridge/[...path]/route";
import { sendToChief } from "@/lib/bridge";
import { timedOut } from "@/lib/outbox";
import { uploadTimeoutMs } from "@/lib/upload-limits";

/* Review P1: a send with files gets time in proportion to its size, in the page and in the proxy alike. */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A bridge that never answers: only a time limit ends the request. */
const silent = () =>
  vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))));
/** Whether a promise has settled yet, read at any moment. */
function watch<T>(p: Promise<T>) {
  const state = { settled: false };
  p.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

it("two minutes, plus the time the bytes take at 1 Mbit/s", () => {
  expect(uploadTimeoutMs(0)).toBe(120_000);
  expect(uploadTimeoutMs(12_500_000)).toBe(220_000);
  // The largest message (55 MB of files, about 73 MB on the wire): about twelve minutes.
  expect(uploadTimeoutMs((55 * 1024 * 1024 * 4) / 3)).toBeGreaterThan(11 * 60_000);
});

it("the page waits for a big upload past the old flat two minutes, and its own timeout counts as one", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", silent());
  const sent = sendToChief("the photos", [{ name: "a.jpg", mime: "image/jpeg", data_url: "x".repeat(12_500_000) }], "id-1", "main");
  const failure = sent.catch((e: unknown) => e);
  const state = watch(sent);
  await vi.advanceTimersByTimeAsync(200_000);
  expect(state.settled).toBe(false);
  await vi.advanceTimersByTimeAsync(25_000);
  const error = await failure;
  expect(error).toMatchObject({ status: 408 });
  expect(timedOut(error)).toBe(true);
});

it("the proxy gives a send as long as the page does, and a little more", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", silent());
  const req = new NextRequest("http://127.0.0.1:3000/api/bridge/send", {
    method: "POST",
    headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json", "content-length": "12500000" },
    body: "{}",
  });
  const answer = POST(req, { params: Promise.resolve({ path: ["send"] }) });
  const state = watch(answer);
  await vi.advanceTimersByTimeAsync(222_000);
  expect(state.settled).toBe(false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect((await answer).status).toBe(502);
});
