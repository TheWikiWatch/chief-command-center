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
  const list = await screen.findByRole("dialog", { name: "Threads with Nova" });
  expect(within(list).getByRole("img", { name: "Working" })).toBeInTheDocument();
  expect(within(list).getByRole("button", { name: /^Main/ })).toHaveAttribute("aria-current", "true");
});

it("switches threads and makes a new one", async () => {
  const posts = route();
  const onChange = vi.fn();
  render(<ThreadSwitcher current="main" onChange={onChange} onFresh={() => {}} phone={false} />);
  fireEvent.click(await screen.findByRole("button", { name: /Switch threads/ }));
  fireEvent.click((await screen.findByText("Trip planning")).closest("button")!);
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

// A1: a small dialog, not a menu (it holds forms), that keyboard and screen-reader users can move through.
it("opens with the open thread focused, and Escape gives the focus back to the pill", async () => {
  route();
  render(<ThreadSwitcher current="t-1234abcd" onChange={() => {}} onFresh={() => {}} phone={false} />);
  const pill = await screen.findByRole("button", { name: "Thread: Trip planning. Switch threads" });
  expect(pill).toHaveAttribute("aria-haspopup", "dialog");
  pill.focus();
  fireEvent.click(pill);
  const list = await screen.findByRole("dialog", { name: "Threads with Nova" });
  expect(list).not.toHaveAttribute("aria-modal");
  await waitFor(() => expect(document.activeElement).toHaveAttribute("aria-current", "true"));
  expect(document.activeElement).toHaveTextContent("Trip planning");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(pill);
});

it("tabbing out closes it, and after a pick the newly opened thread's pill has the focus", async () => {
  route();
  const onChange = vi.fn();
  const view = render(
    <>
      <ThreadSwitcher key="main" current="main" onChange={onChange} onFresh={() => {}} phone={false} />
      <button type="button">Elsewhere</button>
    </>,
  );
  const pill = await screen.findByRole("button", { name: /Switch threads/ });
  fireEvent.click(pill);
  const list = await screen.findByRole("dialog", { name: "Threads with Nova" });
  fireEvent.focusOut(within(list).getByRole("button", { name: /^Main/ }), { relatedTarget: screen.getByRole("button", { name: "Elsewhere" }) });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  fireEvent.click(pill);
  fireEvent.click((await screen.findByText("Taxes")).closest("button")!);
  expect(onChange).toHaveBeenCalledWith("t-5678abcd");
  // The shell remounts the chat on the thread picked, and its switcher with it.
  view.rerender(
    <>
      <ThreadSwitcher key="t-5678abcd" current="t-5678abcd" onChange={onChange} onFresh={() => {}} phone={false} />
      <button type="button">Elsewhere</button>
    </>,
  );
  await waitFor(() => expect(document.activeElement).toHaveAccessibleName(/Switch threads/));
});

it("the proxy forwards the thread routes", () => {
  expect(permittedOperation("bridge", "GET", ["threads"])).toBe(true);
  for (const op of ["threads", "threads/rename", "threads/archive", "threads/fresh"]) expect(permittedOperation("bridge", "POST", op.split("/"))).toBe(true);
  expect(permittedOperation("bridge", "POST", ["threads", "delete"])).toBe(false);
});
