import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { SecondBrainSetup } from "@/components/second-brain/setup";

type Handler = (body: Record<string, unknown>) => unknown;

const STATUS = { ok: true, configured: false, path: "", exists: false, wiki_path: "", mode: null, skill_installed: false, default_path: "C:\Users\me\Documents\Second Brain" };
const PLAN = { folders: ["00 Inbox", "10 Projects"], files: ["AGENTS.md", "Home.md", "00 Inbox/Welcome.md"], existing: [] };

function route(handlers: Record<string, Handler>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1:3100");
      const path = url.pathname.replace("/api/bridge/setup/", "").replace("/api/", "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ path, body });
      const handler = handlers[path];
      if (!handler) return Response.json({ ok: true });
      return Response.json(handler(body));
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("creates a new Second Brain after showing what will be added", async () => {
  const calls = route({
    "second-brain": (body) =>
      body.mode ? { ok: true, path: body.path, mode: body.mode, created: ["00 Inbox/", "AGENTS.md"], kept: [], next_prompt: "" } : STATUS,
    "second-brain/inspect": (body) => ({
      ok: true, path: body.path, exists: false, empty: true, writable: true, obsidian: false, ours: false,
      notes: 0, files: 0, top_folders: [], truncated: false, choices: ["new"], plans: { new: PLAN },
    }),
  });
  const done = vi.fn();
  render(<SecondBrainSetup onDone={done} />);
  const input = await screen.findByDisplayValue("C:\Users\me\Documents\Second Brain");
  expect(input).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check this folder" }));
  expect(await screen.findByRole("heading", { name: "Create a new Second Brain" })).toBeTruthy();
  expect(screen.getByText(/Will add 3 files and 2 folders/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show the full list" }));
  expect(screen.getByRole("list", { name: "Everything that will be created" }).textContent).toContain("00 Inbox/Welcome.md");
  fireEvent.click(screen.getByRole("button", { name: "Create my Second Brain" }));
  expect(await screen.findByRole("heading", { name: "Your Second Brain is ready" })).toBeTruthy();
  expect(calls.find((c) => c.path === "second-brain" && c.body.mode)?.body).toEqual({ path: "C:\Users\me\Documents\Second Brain", mode: "new" });
  expect(done).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: /Ask .* to/ })).toBeNull();
});

it("describes an existing vault and offers the three choices plainly", async () => {
  const calls = route({
    "second-brain": (body) =>
      body.mode
        ? { ok: true, path: body.path, mode: body.mode, created: ["AGENTS.md"], kept: [], next_prompt: "Please propose a move plan." }
        : STATUS,
    "second-brain/inspect": (body) => ({
      ok: true, path: body.path, exists: true, empty: false, writable: true, obsidian: true, ours: false,
      notes: 1240, files: 1300, top_folders: Array.from({ length: 18 }, (_, i) => `F${i}`), truncated: false,
      choices: ["keep", "reorganize"], plans: { keep: PLAN, reorganize: PLAN },
    }),
  });
  const ask = vi.fn(async () => undefined);
  render(<SecondBrainSetup onAskChief={ask} />);
  fireEvent.change(await screen.findByDisplayValue(/Second Brain/), { target: { value: "D:\Vault" } });
  fireEvent.click(screen.getByRole("button", { name: "Check this folder" }));
  expect(await screen.findByRole("heading", { name: "This folder already has notes" })).toBeTruthy();
  expect(screen.getByText(/It has 1,240 notes in 18 folders\. It looks like an Obsidian vault\./)).toBeTruthy();
  const keep = screen.getByRole("radio", { name: /Keep my folders as they are/ });
  const reorganize = screen.getByRole("radio", { name: /Reorganize into Projects/ });
  expect(keep.getAttribute("aria-checked")).toBe("true");
  expect(reorganize.textContent).toMatch(/Nothing is moved now/);
  expect(screen.getByRole("button", { name: /Use a different folder/ })).toBeTruthy();
  fireEvent.click(reorganize);
  fireEvent.click(screen.getByRole("button", { name: "Set up this folder" }));
  await screen.findByRole("heading", { name: "Your Second Brain is ready" });
  expect(calls.find((c) => c.body.mode)?.body).toEqual({ path: "D:\Vault", mode: "reorganize" });
  fireEvent.click(screen.getByRole("button", { name: /for a move plan/ }));
  await waitFor(() => expect(ask).toHaveBeenCalledWith("Please propose a move plan."));
  expect(await screen.findByRole("button", { name: /will reply in chat/ })).toBeTruthy();
});

it("goes back to choose another folder, and shows errors in plain words", async () => {
  route({
    "second-brain": () => STATUS,
    "second-brain/inspect": (body) =>
      String(body.path).startsWith("C:\Windows")
        ? { ok: false, error: "That folder belongs to the system or to Chief itself. Choose one of your own folders." }
        : {
            ok: true, path: body.path, exists: true, empty: false, writable: false, obsidian: false, ours: false, notes: 3, files: 3,
            top_folders: [], truncated: false, choices: ["keep", "reorganize"], plans: { keep: PLAN, reorganize: PLAN },
          },
  });
  render(<SecondBrainSetup />);
  const input = await screen.findByDisplayValue(/Second Brain/);
  fireEvent.change(input, { target: { value: "C:\Windows\Notes" } });
  fireEvent.click(screen.getByRole("button", { name: "Check this folder" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/belongs to the system/);

  fireEvent.change(input, { target: { value: "D:\ReadOnly" } });
  fireEvent.click(screen.getByRole("button", { name: "Check this folder" }));
  await screen.findByRole("heading", { name: "This folder already has notes" });
  expect(screen.getByRole("alert").textContent).toMatch(/can't write to this folder/);
  expect((screen.getByRole("button", { name: "Set up this folder" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Use a different folder/ }));
  expect(await screen.findByRole("heading", { name: "Your Second Brain" })).toBeTruthy();
});
