import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { SecondBrainSetup } from "@/components/second-brain/setup";

type Handler = (body: Record<string, unknown>) => unknown;

const HOME = "C:\\Users\\me\\Documents\\Second Brain";
const STATUS = { ok: true, configured: false, path: "", exists: false, wiki_path: "", mode: null, skill_installed: false, default_path: HOME };
const PLAN = { folders: ["00 Inbox", "10 Projects"], files: ["AGENTS.md", "Home.md", "00 Inbox/Welcome.md"], existing: [] };
const WIKI_PLAN = { folders: ["drop", "raw/originals", "wiki/entities"], files: ["_CLAUDE.md", "boards/Personal.md"], existing: [] };
const EMPTY = { folders: [], files: [], existing: [] };

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

const folder = (over: Record<string, unknown>) => ({
  ok: true, exists: true, empty: false, writable: true, obsidian: false, ours: false, notes: 0, files: 0,
  top_folders: [], truncated: false, format: "para", format_detected: null, manual: "", ...over,
});

async function chooseFormat(label: "Organized" | "Agent-first wiki", source: "Start a new Second Brain" | "Use my existing folder") {
  expect(await screen.findByRole("heading", { name: "Your Second Brain" })).toBeTruthy();
  const cont = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
  expect(cont.disabled).toBe(true); // a format must be chosen
  fireEvent.click(screen.getByRole("radio", { name: new RegExp(label) }));
  fireEvent.click(cont);
  expect(await screen.findByRole("heading", { name: "A new one, or one you have?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: new RegExp(source) }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("asks for the format first, explaining each, then creates a new Second Brain after showing what will be added", async () => {
  const calls = route({
    "second-brain": (body) =>
      body.mode ? { ok: true, path: body.path, mode: body.mode, format: "para", created: ["00 Inbox/", "AGENTS.md"], kept: [], next_prompt: "" } : STATUS,
    "second-brain/inspect": (body) => folder({ path: body.path, exists: false, empty: true, choices: ["new"], plans: { new: PLAN } }),
  });
  const done = vi.fn();
  render(<SecondBrainSetup onDone={done} />);
  expect(await screen.findByRole("radio", { name: /Organized.*For browsing your notes yourself/ })).toBeTruthy();
  expect(screen.getByRole("radio", { name: /Agent-first wiki.*Kanban boards/ })).toBeTruthy();
  await chooseFormat("Organized", "Start a new Second Brain");
  expect(await screen.findByDisplayValue(HOME)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check this folder" }));
  expect(await screen.findByRole("heading", { name: "Create a new Organized Second Brain" })).toBeTruthy();
  expect(calls.find((c) => c.path === "second-brain/inspect")?.body).toEqual({ path: HOME, format: "para" });
  expect(screen.getByText(/Will add 3 files and 2 folders/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show the full list" }));
  expect(screen.getByRole("list", { name: "Everything that will be created" }).textContent).toContain("00 Inbox/Welcome.md");
  fireEvent.click(screen.getByRole("button", { name: "Create my Second Brain" }));
  expect(await screen.findByRole("heading", { name: "Your Second Brain is ready" })).toBeTruthy();
  expect(calls.find((c) => c.path === "second-brain" && c.body.mode)?.body).toEqual({ path: HOME, mode: "new", format: "para" });
  expect(done).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: /Ask .* to/ })).toBeNull();
});

it("creates an agent-first wiki and says how to capture into it", async () => {
  const calls = route({
    "second-brain": (body) =>
      body.mode ? { ok: true, path: body.path, mode: body.mode, format: "wiki", rules: "_CLAUDE.md", created: ["drop/", "_CLAUDE.md"], kept: [], next_prompt: "" } : STATUS,
    "second-brain/inspect": (body) => folder({ path: body.path, exists: false, empty: true, format: "wiki", choices: ["new"], plans: { new: WIKI_PLAN } }),
  });
  render(<SecondBrainSetup />);
  await chooseFormat("Agent-first wiki", "Start a new Second Brain");
  fireEvent.click(await screen.findByRole("button", { name: "Check this folder" }));
  expect(await screen.findByRole("heading", { name: "Create a new Agent-first wiki Second Brain" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create my Second Brain" }));
  await screen.findByRole("heading", { name: "Your Second Brain is ready" });
  expect(calls.find((c) => c.body.mode)?.body).toEqual({ path: HOME, mode: "new", format: "wiki" });
  expect(screen.getByText(/drop a file into/)).toBeTruthy();
  expect(screen.getByText(/Tasks show in Today from your boards/)).toBeTruthy();
});

it("uses an existing folder with its own rules as it is: nothing added, routines off unless switched on", async () => {
  const calls = route({
    "second-brain": (body) =>
      body.mode
        ? {
            ok: true, path: body.path, mode: body.mode, format: "wiki", rules: "_CLAUDE.md", own_rules: true, routines_on: false,
            created: [], kept: [], next_prompt: "Read its rules file (_CLAUDE.md) first.",
          }
        : STATUS,
    "second-brain/inspect": (body) =>
      folder({
        path: body.path, obsidian: true, notes: 573, files: 782, top_folders: ["boards", "raw", "wiki"], format: "wiki", format_detected: "wiki",
        manual: "_CLAUDE.md", choices: ["keep", "reorganize"], plans: { keep: EMPTY, reorganize: EMPTY },
      }),
  });
  const ask = vi.fn(async () => undefined);
  render(<SecondBrainSetup onAskChief={ask} />);
  await chooseFormat("Agent-first wiki", "Use my existing folder");
  const input = await screen.findByLabelText("Folder");
  expect((input as HTMLInputElement).value).toBe(""); // an existing folder is chosen, not defaulted
  fireEvent.change(input, { target: { value: "E:\\Notes" } });
  fireEvent.click(screen.getByRole("button", { name: "Check this folder" }));
  expect(await screen.findByRole("heading", { name: "This folder has its own rules" })).toBeTruthy();
  expect(screen.getByText(/will follow its _CLAUDE\.md and add nothing to the folder\. It has 573 notes in 3 folders/)).toBeTruthy();
  expect(screen.queryByRole("radio", { name: /Keep my folders/ })).toBeNull();
  expect(screen.queryByText(/Will add/)).toBeNull();
  const routines = screen.getByRole("switch", { name: "Scheduled routines off" });
  expect(routines.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Use this folder" }));
  await screen.findByRole("heading", { name: "Your Second Brain is ready" });
  expect(calls.find((c) => c.body.mode)?.body).toEqual({ path: "E:\\Notes", mode: "keep", format: "wiki", routines: false });
  expect(screen.getByText(/Nothing was added: .* follows its _CLAUDE\.md/)).toBeTruthy();
  expect(screen.getByText(/The scheduled routines are off/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /to read its rules/ }));
  await waitFor(() => expect(ask).toHaveBeenCalledWith("Read its rules file (_CLAUDE.md) first."));
});

it("notices a folder in the other format and switches with one click", async () => {
  const calls = route({
    "second-brain": () => STATUS,
    "second-brain/inspect": (body) =>
      folder({
        path: body.path, notes: 40, top_folders: ["raw", "wiki"], format: body.format ?? "para", format_detected: "wiki",
        manual: "", choices: ["keep", "reorganize"], plans: body.format === "wiki" ? { keep: WIKI_PLAN, reorganize: WIKI_PLAN } : { keep: PLAN, reorganize: PLAN },
      }),
  });
  render(<SecondBrainSetup />);
  await chooseFormat("Organized", "Use my existing folder");
  fireEvent.change(await screen.findByLabelText("Folder"), { target: { value: "E:\\Wiki" } });
  fireEvent.click(screen.getByRole("button", { name: "Check this folder" }));
  expect(await screen.findByText(/already looks like an/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Use it as Agent-first wiki" }));
  await waitFor(() => expect(calls.filter((c) => c.path === "second-brain/inspect").at(-1)?.body).toEqual({ path: "E:\\Wiki", format: "wiki" }));
  expect(await screen.findByRole("radio", { name: /Reorganize into the agent-first wiki layout/ })).toBeTruthy();
  expect(screen.queryByText(/already looks like an/)).toBeNull();
});

it("describes an existing vault without rules and offers keep or reorganize plainly", async () => {
  const calls = route({
    "second-brain": (body) =>
      body.mode ? { ok: true, path: body.path, mode: body.mode, format: "para", created: ["AGENTS.md"], kept: [], next_prompt: "Please propose a move plan." } : STATUS,
    "second-brain/inspect": (body) =>
      folder({
        path: body.path, obsidian: true, notes: 1240, files: 1300, top_folders: Array.from({ length: 18 }, (_, i) => `F${i}`),
        choices: ["keep", "reorganize"], plans: { keep: PLAN, reorganize: PLAN },
      }),
  });
  const ask = vi.fn(async () => undefined);
  render(<SecondBrainSetup onAskChief={ask} />);
  await chooseFormat("Organized", "Use my existing folder");
  fireEvent.change(await screen.findByLabelText("Folder"), { target: { value: "D:\\Vault" } });
  fireEvent.click(screen.getByRole("button", { name: "Check this folder" }));
  expect(await screen.findByRole("heading", { name: "This folder already has notes" })).toBeTruthy();
  expect(screen.getByText(/It has 1,240 notes in 18 folders\. It looks like an Obsidian vault\./)).toBeTruthy();
  const keep = screen.getByRole("radio", { name: /Keep my folders as they are/ });
  const reorganize = screen.getByRole("radio", { name: /Reorganize into Projects/ });
  expect(keep.getAttribute("aria-checked")).toBe("true");
  expect(reorganize.textContent).toMatch(/Nothing is moved now/);
  fireEvent.click(reorganize);
  fireEvent.click(screen.getByRole("button", { name: "Set up this folder" }));
  await screen.findByRole("heading", { name: "Your Second Brain is ready" });
  expect(calls.find((c) => c.body.mode)?.body).toEqual({ path: "D:\\Vault", mode: "reorganize", format: "para" });
  fireEvent.click(screen.getByRole("button", { name: /for a move plan/ }));
  await waitFor(() => expect(ask).toHaveBeenCalledWith("Please propose a move plan."));
  expect(await screen.findByRole("button", { name: /will reply in chat/ })).toBeTruthy();
});

it("goes back step by step, and shows errors in plain words", async () => {
  route({
    "second-brain": () => STATUS,
    "second-brain/inspect": (body) =>
      String(body.path).startsWith("C:\\Windows")
        ? { ok: false, error: "That folder belongs to the system or to Chief itself. Choose one of your own folders." }
        : folder({ path: body.path, writable: false, notes: 3, files: 3, choices: ["keep", "reorganize"], plans: { keep: PLAN, reorganize: PLAN } }),
  });
  render(<SecondBrainSetup />);
  await chooseFormat("Organized", "Use my existing folder");
  const input = await screen.findByLabelText("Folder");
  fireEvent.change(input, { target: { value: "C:\\Windows\\Notes" } });
  fireEvent.click(screen.getByRole("button", { name: "Check this folder" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/belongs to the system/);

  fireEvent.change(input, { target: { value: "D:\\ReadOnly" } });
  fireEvent.click(screen.getByRole("button", { name: "Check this folder" }));
  await screen.findByRole("heading", { name: "This folder already has notes" });
  expect(screen.getByRole("alert").textContent).toMatch(/can't write to this folder/);
  expect((screen.getByRole("button", { name: "Set up this folder" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: /Use a different folder/ }));
  expect(await screen.findByRole("heading", { name: "Which folder is it?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("heading", { name: "A new one, or one you have?" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("heading", { name: "Your Second Brain" })).toBeTruthy();
  expect(screen.getByRole("radio", { name: /Organized/ }).getAttribute("aria-checked")).toBe("true"); // the choice is kept
});
