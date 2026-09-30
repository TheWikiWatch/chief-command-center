import { afterEach, expect, it, vi } from "vitest";

import { closeNotifications, shownOnScreen, subscribeOpenTarget, takeLaunchTarget } from "@/lib/open-target";

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

it("reads a notification's target from a cold start once and cleans the address bar", () => {
  window.history.replaceState(null, "", "/?open=fleet&view=health&keep=1");
  expect(takeLaunchTarget()).toEqual({ tab: "fleet", approval: undefined, view: "health" });
  expect(window.location.search).toBe("?keep=1");
  expect(takeLaunchTarget()).toBeNull();
});

it("ignores unknown tabs", () => {
  window.history.replaceState(null, "", "/?open=settings");
  expect(takeLaunchTarget()).toBeNull();
});

it("passes on worker messages that say where to go", () => {
  const listeners = new Map<string, (e: MessageEvent) => void>();
  const sw = {
    addEventListener: (type: string, fn: (e: MessageEvent) => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  Object.defineProperty(navigator, "serviceWorker", { value: sw, configurable: true });
  const seen: unknown[] = [];
  const stop = subscribeOpenTarget((t) => seen.push(t));
  listeners.get("message")!({ data: { type: "chief-open", tab: "chat", approval: "r1", view: "" } } as MessageEvent);
  listeners.get("message")!({ data: { type: "other" } } as MessageEvent);
  expect(seen).toEqual([{ tab: "chat", approval: "r1", view: undefined }]);
  stop();
  expect(listeners.has("message")).toBe(false);
});

it("closes reply and approval notifications, not fleet flags", async () => {
  const shown = ["chief-reply", "approval-r1", "fleet-flags"].map((tag) => ({ tag, close: vi.fn() }));
  Object.defineProperty(navigator, "serviceWorker", {
    value: { getRegistration: async () => ({ getNotifications: async () => shown }) },
    configurable: true,
  });
  expect(await closeNotifications()).toBe(2);
  expect(shown.map((n) => n.close.mock.calls.length)).toEqual([1, 1, 0]);
  expect(shownOnScreen("fleet-flags")).toBe(false);
});
