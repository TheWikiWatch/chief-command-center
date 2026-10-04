// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/bridge/[...path]/route";

// A tester's phone loaded slowly, and the PC logged "failed to pipe response ... TimeoutError" 18 times an hour:
// the proxy's time limit covered the whole answer, so a big one streaming to a phone was cut off half-way.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });

it("lets an answer that has started finish streaming, however long past the limit", async () => {
  vi.useFakeTimers();
  const chunks = ['{"ok":true,', '"lastId":7,', '"messages":[],"sessionKey":"s"}'];
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      await new Promise((r) => setTimeout(r, 6_000)); // 18 s in all: past the 8 s limit
      const next = chunks.shift();
      if (next) ctrl.enqueue(new TextEncoder().encode(next));
      else ctrl.close();
    },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers: { "content-type": "application/json" } })));
  const res = await GET(new NextRequest("http://127.0.0.1:3000/api/bridge/transcript?after=0"), ctx("transcript"));
  const text = res.text();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(JSON.parse(await text)).toEqual({ ok: true, lastId: 7, messages: [], sessionKey: "s" });
});

it("still gives up on a bridge that doesn't start answering", async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)))),
  );
  const res = GET(new NextRequest("http://127.0.0.1:3000/api/bridge/snapshot"), ctx("snapshot"));
  await vi.advanceTimersByTimeAsync(16_000);
  expect((await res).status).toBe(502);
});

it("gives the chief's report summary a minute", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise((resolve) => setTimeout(() => resolve(Response.json({ ok: true, summary: "s" })), 30_000));
    }),
  );
  const req = new NextRequest("http://127.0.0.1:3000/api/bridge/report/draft", {
    method: "POST",
    headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" },
    body: JSON.stringify({ message: "m" }),
  });
  const res = POST(req, ctx("report", "draft"));
  await vi.advanceTimersByTimeAsync(31_000);
  expect((await res).status).toBe(200);
  expect(signal?.aborted).toBe(false);
});
