// @vitest-environment node
// Live contract against the bridge on 7790: plain Node fetch (happy-dom would apply browser CORS).
import { describe, expect, it } from "vitest";

/**
 * Live bridge smoke — only when CHIEF_BRIDGE_SMOKE=1 on MainPC.
 * Covers: health auth, transcript shape, generating boolean, /events content-type.
 */
const live = process.env.CHIEF_BRIDGE_SMOKE === "1";
const base = process.env.CHIEF_BRIDGE_URL || "http://127.0.0.1:7790";
const token = process.env.CHIEF_BRIDGE_TOKEN || "";

describe.skipIf(!live)("bridge contract (live)", () => {
  it("health requires bearer and returns gateway:true", async () => {
    const bare = await fetch(`${base}/health`);
    expect([401, 403]).toContain(bare.status);

    const ok = await fetch(`${base}/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { ok?: boolean; gateway?: boolean };
    expect(body.ok).toBe(true);
    expect(body.gateway).toBe(true);
  });

  it("transcript has sessionKey, messages[], generating boolean", async () => {
    const res = await fetch(`${base}/transcript`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      sessionKey?: string;
      messages?: unknown[];
      generating?: boolean;
      lastId?: number;
    };
    expect(typeof data.sessionKey).toBe("string");
    expect(Array.isArray(data.messages)).toBe(true);
    expect(typeof data.generating).toBe("boolean");
    expect(typeof data.lastId).toBe("number");
  });

  it("a long-poll holds while nothing changes and carries the approval", async () => {
    const auth = { headers: { Authorization: `Bearer ${token}` } };
    const first = (await (await fetch(`${base}/transcript`, auth)).json()) as { lastId: number; generating: boolean; approval?: { requestId?: string } | null; longpoll?: boolean };
    expect(first.longpoll).toBe(true);
    expect("approval" in first).toBe(true);
    const q = new URLSearchParams({ after: String(first.lastId), wait: "2", gen: first.generating ? "1" : "0", approval: first.approval?.requestId || "" });
    const started = Date.now();
    const held = (await (await fetch(`${base}/transcript?${q}`, auth)).json()) as { messages: unknown[] };
    // Either Chief said something (returned early with it) or it waited out the two seconds.
    if (!held.messages.length) expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
  }, 15_000);

  it("/events is text/event-stream (not shadowed 404)", async () => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1500);
    try {
      const res = await fetch(`${base}/events`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        signal: ac.signal,
      });
      expect(res.status).toBe(200);
      const ct = res.headers.get("content-type") || "";
      expect(ct.includes("text/event-stream")).toBe(true);
    } finally {
      clearTimeout(t);
      ac.abort();
    }
  });
});
