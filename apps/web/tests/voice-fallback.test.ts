import { afterEach, expect, it, vi } from "vitest";

import { speakText } from "@/lib/bridge";
import { VOICE_FALLBACK_EVENT } from "@/lib/voice-events";

afterEach(() => vi.unstubAllGlobals());

const respond = (body: object) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })));

it("announces when Edge spoke instead of the chosen engine", async () => {
  const heard = vi.fn();
  window.addEventListener(VOICE_FALLBACK_EVENT, heard);
  respond({ ok: true, data_url: "data:audio/mpeg;base64,AA", fallback: true, fallback_reason: "not running" });
  await speakText("Hi");
  expect(heard).toHaveBeenCalledTimes(1);
  expect((heard.mock.calls[0][0] as CustomEvent).detail.reason).toBe("not running");
  respond({ ok: true, data_url: "data:audio/mpeg;base64,AA" });
  await speakText("Hi");
  expect(heard).toHaveBeenCalledTimes(1);
  window.removeEventListener(VOICE_FALLBACK_EVENT, heard);
});
