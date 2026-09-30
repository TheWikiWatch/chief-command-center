import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PersonaEditor } from "@/components/persona/persona-editor";
import { memoryOps, memoryUsed } from "@/lib/persona-client";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PERSONA = {
  ok: true,
  profile: "chief",
  soul: { text: "You are Chief.\n", hash: "h1", limit: 20000, warnings: [], history: [{ id: "SOUL.md.bak-older", at: 1790000000, size: 30, kind: "backup" }] },
  memory: { entries: ["Owner prefers short answers.", "Timezone is Eastern."], limit: 2200, used: 50, enabled: true },
  user: { entries: ["Name is Sam."], limit: 1375, used: 12, enabled: true },
};

function stub(handlers: Record<string, (body: Record<string, unknown>) => unknown>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1:3100");
      const path = url.pathname.replace("/api/bridge/persona", "") || "/";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : Object.fromEntries(url.searchParams);
      calls.push({ path, body });
      return Response.json((handlers[path] || (() => ({ ok: false, error: "no handler" })))(body));
    }),
  );
  return calls;
}

it("turns edited rows into pinned Hermes operations", () => {
  const ops = memoryOps([
    { key: "a", from: "keep", text: "keep" },
    { key: "b", from: "old", text: "new" },
    { key: "c", from: "gone", text: "gone", deleted: true },
    { key: "d", from: "blank", text: "   " },
    { key: "e", text: "added" },
    { key: "f", text: "" },
  ]);
  expect(ops).toEqual([
    { action: "replace", entry: "old", content: "new" },
    { action: "remove", entry: "gone" },
    { action: "remove", entry: "blank" },
    { action: "add", content: "added" },
  ]);
  expect(memoryUsed(["ab", "cd"])).toBe("ab\n§\ncd".length);
});

it("saves SOUL against the version it opened, and a changed file is a choice, not an overwrite", async () => {
  let saves = 0;
  const calls = stub({
    "/": () => PERSONA,
    "/soul": (body) => {
      saves++;
      if (body.base_hash === "h1") return { ok: false, conflict: true, error: "changed", current: { text: "You are Chief (edited by the bot).\n", hash: "h2" } };
      return { ok: true, hash: "h3", warnings: [], history: PERSONA.soul.history };
    },
  });
  render(<PersonaEditor profile="chief" name="Chief" />);
  const box = await screen.findByLabelText(/SOUL.md/);
  fireEvent.change(box, { target: { value: "You are Chief, calm.\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText(/changed since you opened it/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
  expect(await screen.findByText(/Saved\. The previous version is in History\./)).toBeInTheDocument();
  expect(saves).toBe(2);
  expect(calls.filter((c) => c.path === "/soul").map((c) => c.body.base_hash)).toEqual(["h1", "h2"]);
});

it("edits memory entries and saves them as one batch", async () => {
  const calls = stub({
    "/": () => PERSONA,
    "/memory": () => ({ ok: true, memory: { ...PERSONA.memory, entries: ["Owner prefers short answers.", "Timezone is Central.", "Likes dark mode."] }, user: PERSONA.user }),
  });
  render(<PersonaEditor profile="chief" name="Chief" />);
  fireEvent.click(await screen.findByRole("tab", { name: "Chief's notes" }));
  fireEvent.change(await screen.findByLabelText("Entry 2"), { target: { value: "Timezone is Central." } });
  fireEvent.click(screen.getByRole("button", { name: "Add an entry" }));
  fireEvent.change(screen.getByLabelText("Entry 3"), { target: { value: "Likes dark mode." } });
  fireEvent.click(screen.getByRole("button", { name: "Save 2 changes" }));
  expect(await screen.findByText("Saved.")).toBeInTheDocument();
  expect(calls.find((c) => c.path === "/memory")?.body).toEqual({
    profile: "chief",
    target: "memory",
    ops: [
      { action: "replace", entry: "Timezone is Eastern.", content: "Timezone is Central." },
      { action: "add", content: "Likes dark mode." },
    ],
  });
});

it("a memory the bot changed meanwhile shows the reason and the fresh entries", async () => {
  stub({
    "/": () => PERSONA,
    "/memory": () => ({
      ok: false,
      conflict: true,
      error: "The chief changed this memory while you were editing. Your view is refreshed; make the change again.",
      memory: { ...PERSONA.memory, entries: ["Owner prefers short answers.", "Timezone is Pacific."] },
      user: PERSONA.user,
    }),
  });
  render(<PersonaEditor profile="chief" name="Chief" />);
  fireEvent.click(await screen.findByRole("tab", { name: "Chief's notes" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete entry 2" }));
  fireEvent.click(screen.getByRole("button", { name: "Save 1 change" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("changed this memory while you were editing");
  expect((screen.getByLabelText("Entry 2") as HTMLTextAreaElement).value).toBe("Timezone is Pacific.");
});

it("won't save a memory that is over its limit", async () => {
  stub({ "/": () => ({ ...PERSONA, user: { ...PERSONA.user, limit: 20 } }) });
  render(<PersonaEditor profile="chief" name="Chief" />);
  fireEvent.click(await screen.findByRole("tab", { name: "About you" }));
  fireEvent.change(await screen.findByLabelText("Entry 1"), { target: { value: "x".repeat(30) } });
  expect(screen.getByText(/over the limit/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save 1 change" })).toBeDisabled();
});

it("lists SOUL history and loads an older version into the editor", async () => {
  stub({ "/": () => PERSONA, "/soul/version": () => ({ ok: true, id: "SOUL.md.bak-older", text: "You were someone else.\n" }) });
  render(<PersonaEditor profile="chief" name="Chief" />);
  fireEvent.click(await screen.findByRole("button", { name: /History \(1\)/ }));
  const list = screen.getByRole("list");
  fireEvent.click(within(list).getByRole("button", { name: "View" }));
  fireEvent.click(await screen.findByRole("button", { name: "Use this version" }));
  expect((screen.getByLabelText(/SOUL.md/) as HTMLTextAreaElement).value).toBe("You were someone else.\n");
  expect(screen.getByText(/Loaded into the editor/)).toBeInTheDocument();
});
