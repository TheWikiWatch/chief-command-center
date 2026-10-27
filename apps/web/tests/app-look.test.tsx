import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { LookGroup } from "@/components/settings/general";
import { BOOT_SCRIPT, LOOK_KEY, SWATCHES, accentTokens, applyLook, contrast } from "@/lib/app-look";
import { permittedOperation } from "@/lib/proxy-policy";

/* The app's look (lib/app-look.ts, app_look.py): readable accent tokens for any colour in both modes, the page
   and this device's copy updated together, and Settings → General's Appearance group. */

const rgb = (t: string) => t.split(" ").map(Number) as [number, number, number];

let look: Record<string, unknown>;
let posts: Record<string, unknown>[];

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("style");
  posts = [];
  look = { ok: true, accent: "theme", mode: "dark", by: "owner", at: 0, canUndo: false };
  vi.stubGlobal("fetch", async (_input: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      look = body.undo ? { ...look, accent: "theme", mode: "dark", by: "owner", canUndo: true } : { ...look, ...body, by: "owner", canUndo: true };
    }
    return Response.json(look);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("every swatch and any colour gives text and filled buttons that read, in dark and in light", () => {
  for (const accent of [...SWATCHES.map((s) => s.id).filter((id) => id !== "theme"), "#ffff00", "#101010", "#00ffcc"]) {
    for (const mode of ["dark", "light"] as const) {
      const t = accentTokens(accent, mode)!;
      expect(contrast(rgb(t["--c-accent-solid"]), [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb(t["--c-accent-text"]), mode === "dark" ? [9, 9, 11] : [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
    }
  }
  expect(accentTokens("theme", "dark")).toBeNull(); // the stylesheet's own red
  expect(accentTokens("url(x)", "dark")).toBeNull();
});

it("applying a look sets the page and this device's copy, which the boot script reads before the first paint", () => {
  applyLook({ accent: "violet", mode: "light" });
  const root = document.documentElement;
  expect(root.dataset.theme).toBe("light");
  expect(root.style.getPropertyValue("--c-accent")).toBe("142 78 198");
  root.removeAttribute("data-theme");
  root.removeAttribute("style");
  new Function(BOOT_SCRIPT)(); // what app/layout.tsx runs in <head>
  expect(root.dataset.theme).toBe("light");
  expect(root.style.getPropertyValue("--c-accent")).toBe("142 78 198");
  applyLook({ accent: "theme", mode: "dark" });
  expect(root.dataset.theme).toBeUndefined();
  expect(root.style.getPropertyValue("--c-accent")).toBe("");
  expect(JSON.parse(localStorage.getItem(LOOK_KEY)!).accent).toBe("theme");
});

it("the boot script ignores a tampered copy", () => {
  localStorage.setItem(LOOK_KEY, JSON.stringify({ mode: "dark", tokens: { "--c-accent": "red; background: url(x)", "--evil": "1 2 3" } }));
  new Function(BOOT_SCRIPT)();
  expect(document.documentElement.style.getPropertyValue("--c-accent")).toBe("");
  expect(document.documentElement.style.getPropertyValue("--evil")).toBe("");
});

it("Appearance: mode and accent save for every window; a look the chief made says so and undoes", async () => {
  look = { ...look, accent: "pink", mode: "light", by: "Chief", canUndo: true };
  render(<LookGroup />);
  expect(await screen.findByText("Chief changed this. Undo puts back what you had.")).toBeTruthy();
  await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
  fireEvent.click(screen.getByRole("radio", { name: "System" }));
  fireEvent.click(screen.getByRole("radio", { name: "Violet" }));
  await waitFor(() => expect(posts).toEqual([{ mode: "system" }, { accent: "violet" }]));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  await waitFor(() => expect(posts.at(-1)).toEqual({ undo: true }));
});

it("the proxy forwards the look's route", () => {
  expect(permittedOperation("bridge", "GET", ["app-look"])).toBe(true);
  expect(permittedOperation("bridge", "POST", ["app-look"])).toBe(true);
});
