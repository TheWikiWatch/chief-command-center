import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AppearanceEditor, startingLook } from "@/components/look/appearance-editor";
import type { FaceLook, Person } from "@/lib/types";

const person = {
  id: "ivy",
  name: "Ivy - Research",
  title: "Ivy - Research",
  description: "",
  section: "",
  shape: "",
  color: "",
  imageKind: "shape",
  custom: false,
  model: "",
  provider: "",
  flavor: "",
  isChief: false,
  ring: "idle",
  jobTitle: "",
} as Person;

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let current: { look: FaceLook | null; revisions: Record<string, number>; hasAvatar: boolean; portrait: boolean; pets: boolean; pet: null };
let conflictNext = false;

beforeEach(() => {
  calls = [];
  conflictNext = false;
  current = { look: { style: "bubble", color: "#00c9bf", body: "round", eyes: "oval" }, revisions: { chief: 3, "hermes-bots": 5 }, hasAvatar: false, portrait: false, pets: false, pet: null };
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
    const path = new URL(input, "http://x").pathname;
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    if (method === "POST" && conflictNext) {
      conflictNext = false;
      current = { ...current, look: { style: "shape", color: "#ff8a93", shape: "pill" }, revisions: { chief: 4, "hermes-bots": 6 } };
      return new Response(JSON.stringify({ conflict: true }), { status: 409 });
    }
    if (method === "POST") current = { ...current, look: body.face, revisions: { chief: 9, "hermes-bots": 9 } };
    return new Response(JSON.stringify(current), { status: 200 });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("starts from the saved look, or a bubble in the bot's own colour when it has none", () => {
  expect(startingLook(person, { style: "shape", color: "#58c57e", shape: "drop" })).toEqual({ style: "shape", color: "#58c57e", shape: "drop" });
  const fresh = startingLook(person, null);
  expect(fresh.style).toBe("bubble");
  expect(fresh.body).toBeTruthy();
});

it("saves the chosen parts with the revisions it read, then hands the new look back", async () => {
  const done = vi.fn();
  render(<AppearanceEditor person={person} onDone={done} />);
  fireEvent.click(await screen.findByRole("button", { name: "Happy", pressed: false }));
  fireEvent.click(screen.getByRole("button", { name: "Drop" }));
  fireEvent.click(screen.getByRole("switch", { name: "Rosy cheeks" }));
  fireEvent.click(screen.getByRole("button", { name: "Colour #b4a5ff" }));
  fireEvent.click(screen.getByRole("button", { name: "Save look" }));
  await waitFor(() => expect(done).toHaveBeenCalled());
  const post = calls.find((c) => c.method === "POST")!;
  expect(post.path).toBe("/api/bridge/look/ivy");
  expect(post.body).toEqual({ face: { style: "bubble", color: "#b4a5ff", body: "drop", eyes: "happy", cheeks: true }, expected: { chief: 3, "hermes-bots": 5 } });
  expect(done).toHaveBeenCalledWith(expect.objectContaining({ eyes: "happy", body: "drop" }));
});

it("a look changed elsewhere in the meantime is never overwritten: it says so and shows the latest", async () => {
  const done = vi.fn();
  conflictNext = true; // the chief restyled Ivy after the editor read the look
  render(<AppearanceEditor person={person} onDone={done} />);
  fireEvent.click(await screen.findByRole("button", { name: "Save look" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/changed somewhere else/);
  expect(done).not.toHaveBeenCalled();
  // The latest look (a pill shape) is what the editor now shows.
  await waitFor(() => expect(screen.getByRole("radio", { name: "Shape" }).getAttribute("aria-checked")).toBe("true"));
});

it("Reset to default saves no look; Cancel changes nothing", async () => {
  const done = vi.fn();
  render(<AppearanceEditor person={person} onDone={done} />);
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  expect(done).toHaveBeenCalledWith(current.look);
  fireEvent.click(screen.getByRole("button", { name: "Reset to default" }));
  await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
  expect(calls.find((c) => c.method === "POST")!.body).toEqual({ face: null, expected: { chief: 3, "hermes-bots": 5 } });
});

it("a photo look can't be saved until a photo is uploaded; portraits are offered only with an image generator", async () => {
  render(<AppearanceEditor person={person} onDone={() => undefined} />);
  fireEvent.click(await screen.findByRole("radio", { name: "Photo" }));
  expect((screen.getByRole("button", { name: "Save look" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("button", { name: "Upload photo" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Draw" })).toBeNull();
});

it("a bridge that can't read the look says so with Try again", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "Profile not found." }), { status: 404 }));
  render(<AppearanceEditor person={person} onDone={() => undefined} />);
  expect((await screen.findByRole("alert")).textContent).toMatch(/Profile not found/);
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
});
