import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ThreadSwitcher } from "@/components/chat/thread-switcher";
import { permittedOperation } from "@/lib/proxy-policy";
import type { ChatThread } from "@/lib/threads-client";

const thread = (id: string, title: string, extra: Partial<ChatThread> = {}): ChatThread => ({
  id,
  title,
  named: true,
  created: 1,
  archived: false,
  lastActivity: 100,
  working: false,
  question: false,
  approval: false,
  ...extra,
});

let threads: ChatThread[] = [];
function route() {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://127.0.0.1:3100").pathname.replace("/api/bridge/", "");
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push({ path, body });
        if (path === "threads") {
          const made = thread("t-0000beef", String(body.title || "New thread"));
          threads = [...threads, made];
          return Response.json({ ok: true, thread: made });
        }
        if (path === "threads/rename") threads = threads.map((t) => (t.id === body.thread ? { ...t, title: String(body.title) } : t));
        if (path === "threads/archive") threads = threads.map((t) => (t.id === body.thread ? { ...t, archived: true } : t));
        return Response.json({ ok: true });
      }
      if (path === "threads") return Response.json({ ok: true, threads });
      return Response.json({ ok: false }, { status: 404 });
    }),
  );
  return posts;
}

beforeEach(() => {
  localStorage.clear();
  threads = [thread("main", "Main"), thread("t-1234abcd", "Trip planning", { working: true }), thread("t-5678abcd", "Taxes", { question: true })];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows the open thread and flags a question waiting in another", async () => {
  route();
  render(<ThreadSwitcher current="main" onChange={() => {}} onFresh={() => {}} phone={false} />);
  const pill = await screen.findByRole("button", { name: "Thread: Main. Switch threads" });
  await waitFor(() => expect(within(pill).getByRole("img", { name: "Needs you" })).toBeInTheDocument());
  fireEvent.click(pill);
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("img", { name: "Working" })).toBeInTheDocument();
  expect(within(menu).getByRole("menuitemradio", { name: /Main/ })).toHaveAttribute("aria-checked", "true");
});

it("switches threads and makes a new one", async () => {
  const posts = route();
  const onChange = vi.fn();
  render(<ThreadSwitcher current="main" onChange={onChange} onFresh={() => {}} phone={false} />);
  fireEvent.click(await screen.findByRole("button", { name: /Switch threads/ }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: /Trip planning/ }));
  expect(onChange).toHaveBeenCalledWith("t-1234abcd");

  fireEvent.click(screen.getByRole("button", { name: /Switch threads/ }));
  fireEvent.click(await screen.findByRole("button", { name: /New thread/ }));
  await waitFor(() => expect(posts[0]?.path).toBe("threads"));
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("t-0000beef"));
});

it("renames, fresh-starts (after confirming) and archives a thread", async () => {
  const posts = route();
  const onFresh = vi.fn();
  render(<ThreadSwitcher current="t-1234abcd" onChange={() => {}} onFresh={onFresh} phone={false} />);
  fireEvent.click(await screen.findByRole("button", { name: /Switch threads/ }));
  fireEvent.click(await screen.findByRole("button", { name: "More for Taxes" }));
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.change(screen.getByLabelText("Thread title"), { target: { value: "Tax return" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(posts[0]).toEqual({ path: "threads/rename", body: { thread: "t-5678abcd", title: "Tax return" } }));

  fireEvent.click(await screen.findByRole("button", { name: "More for Tax return" }));
  fireEvent.click(screen.getByRole("button", { name: "Fresh start" }));
  expect(posts).toHaveLength(1); // nothing yet: it asks first
  fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
  await waitFor(() => expect(posts[1]).toEqual({ path: "threads/fresh", body: { thread: "t-5678abcd" } }));

  fireEvent.click(await screen.findByRole("button", { name: "More for Tax return" }));
  fireEvent.click(screen.getByRole("button", { name: "Archive" }));
  await waitFor(() => expect(posts[2]).toEqual({ path: "threads/archive", body: { thread: "t-5678abcd", archived: true } }));
});

it("a thread that is working can't be fresh-started", async () => {
  route();
  render(<ThreadSwitcher current="main" onChange={() => {}} onFresh={() => {}} phone={false} />);
  fireEvent.click(await screen.findByRole("button", { name: /Switch threads/ }));
  fireEvent.click(await screen.findByRole("button", { name: "More for Trip planning" }));
  fireEvent.click(screen.getByRole("button", { name: "Fresh start" }));
  expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
});

it("the proxy forwards the thread routes", () => {
  expect(permittedOperation("bridge", "GET", ["threads"])).toBe(true);
  for (const op of ["threads", "threads/rename", "threads/archive", "threads/fresh"]) expect(permittedOperation("bridge", "POST", op.split("/"))).toBe(true);
  expect(permittedOperation("bridge", "POST", ["threads", "delete"])).toBe(false);
});
