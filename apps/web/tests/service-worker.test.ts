import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

type Listener = (event: unknown) => void;

/** Load public/sw.js with a fake worker scope and return its event listeners. */
function loadWorker(windows: Array<{ url: string; focused?: boolean; visibilityState?: string }>) {
  const listeners: Record<string, Listener> = {};
  const clientList = windows.map((w) => ({
    ...w,
    focus: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    postMessage: vi.fn(),
  }));
  const clients = { matchAll: vi.fn(async () => clientList), openWindow: vi.fn(async () => undefined) };
  const self = {
    location: { origin: "https://chief.example.ts.net" },
    registration: { showNotification: vi.fn(async () => undefined) },
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
  };
  runInNewContext(readFileSync(path.join(process.cwd(), "public/sw.js"), "utf8"), { self, clients, URL });
  return { listeners, clients, clientList, show: self.registration.showNotification };
}

async function click(listeners: Record<string, Listener>, open: Record<string, string> = { tab: "chat" }) {
  let work: Promise<unknown> = Promise.resolve();
  listeners.notificationclick({ notification: { close: vi.fn(), data: { url: "/", open } }, waitUntil: (p: Promise<unknown>) => (work = p) });
  await work;
}

async function push(listeners: Record<string, Listener>, payload: Record<string, unknown>) {
  let work: Promise<unknown> = Promise.resolve();
  listeners.push({ data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => (work = p) });
  await work;
}

it("focuses the open app without reloading it", async () => {
  const { listeners, clientList, clients } = loadWorker([{ url: "https://chief.example.ts.net/" }]);
  await click(listeners);
  expect(clientList[0].focus).toHaveBeenCalledTimes(1);
  expect(clientList[0].navigate).not.toHaveBeenCalled();
  expect(clients.openWindow).not.toHaveBeenCalled();
});

it("opens a window when the app is not open", async () => {
  const { listeners, clients } = loadWorker([]);
  await click(listeners);
  expect(clients.openWindow).toHaveBeenCalledWith("https://chief.example.ts.net/?open=chat");
});

it("tells the open app where to go instead of navigating it", async () => {
  const { listeners, clientList } = loadWorker([{ url: "https://chief.example.ts.net/" }]);
  await click(listeners, { tab: "chat", approval: "r1" });
  expect(clientList[0].navigate).not.toHaveBeenCalled();
  expect(clientList[0].postMessage).toHaveBeenCalledWith({ type: "chief-open", tab: "chat", approval: "r1", view: "" });
  expect(clientList[0].focus).toHaveBeenCalled();
});

it("a cold start carries the target in the URL", async () => {
  const { listeners, clients } = loadWorker([]);
  await click(listeners, { tab: "fleet", view: "health" });
  expect(clients.openWindow).toHaveBeenCalledWith("https://chief.example.ts.net/?open=fleet&view=health");
});

it("replaces the last notification of a kind and keeps approvals up until handled", async () => {
  const { listeners, show } = loadWorker([{ url: "https://chief.example.ts.net/", focused: false, visibilityState: "hidden" }]);
  await push(listeners, { title: "Chief", body: "Done", tag: "chief-reply", at: 5 });
  expect(show).toHaveBeenLastCalledWith("Chief", expect.objectContaining({ body: "Done", tag: "chief-reply", renotify: true, timestamp: 5, requireInteraction: false }));
  await push(listeners, { title: "Chief needs your approval", body: "git push", tag: "approval-r1", open: { tab: "chat", approval: "r1" } });
  expect(show).toHaveBeenLastCalledWith(
    "Chief needs your approval",
    expect.objectContaining({ tag: "approval-r1", requireInteraction: true, data: { url: "/", open: { tab: "chat", approval: "r1", view: "" } } }),
  );
});

it("stays quiet while the app is on screen on this device", async () => {
  const { listeners, show } = loadWorker([{ url: "https://chief.example.ts.net/", focused: true, visibilityState: "visible" }]);
  await push(listeners, { title: "Chief", body: "Done" });
  expect(show).not.toHaveBeenCalled();
});
