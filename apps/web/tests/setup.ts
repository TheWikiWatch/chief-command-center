import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// findBy*/waitFor give up after one second by default. The whole suite runs in parallel, and on a busy machine
// a heavy component (the chat, the shell) can need longer to settle: a timing failure isn't a real one.
configure({ asyncUtilTimeout: 4000 });

// happy-dom implements element.animate(), and rejects `finished` loudly when motion cancels an
// animation on unmount. Tests don't measure animation, so let motion use its JS animations instead.
if (typeof Element !== "undefined" && "animate" in Element.prototype) {
  delete (Element.prototype as { animate?: unknown }).animate;
}

// Unit tests never reach the network: relative URLs would otherwise hit the live dashboard on
// localhost:3000. A test that needs fetch stubs it (vi.stubGlobal("fetch", ...)); the opt-in live
// bridge contract (CHIEF_BRIDGE_SMOKE=1) keeps the real one.
if (process.env.CHIEF_BRIDGE_SMOKE !== "1") globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new TypeError(`Network is disabled in unit tests (${String(input)})`);
}) as typeof fetch;

// Most component tests describe an install whose chief is named Nova (as in the author's setup);
// identity.test.ts covers the defaults a fresh install shows.
import { beforeEach } from "vitest";
import { resetIdentity, setAssistantTitle } from "@/lib/identity";
beforeEach(() => {
  resetIdentity();
  setAssistantTitle("Nova - Chief of Staff");
});
