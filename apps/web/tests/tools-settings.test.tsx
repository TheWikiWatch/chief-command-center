import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { ToolService, ToolsState } from "@/lib/bridge";

const service = (over: Partial<ToolService>): ToolService => ({
  name: "x",
  label: "X",
  blurb: "",
  badge: "",
  status: "ready",
  hint: "",
  keys: [],
  active: false,
  recommended: true,
  ...over,
});

const fresh: ToolsState = {
  ok: true,
  image: {
    active: null,
    model: null,
    providers: [
      service({ name: "OpenAI (Codex auth)", label: "ChatGPT sign-in", status: "needs_auth", hint: "Needs a ChatGPT sign-in in Hermes" }),
      service({ name: "OpenAI", label: "OpenAI API key", badge: "paid", status: "needs_keys", hint: "Needs an API key", keys: [{ key: "OPENAI_API_KEY", label: "OpenAI key", url: "https://platform.openai.com/api-keys", set: false }] }),
      service({ name: "Krea", label: "Krea", status: "needs_keys", recommended: false, keys: [{ key: "KREA_API_KEY", label: "Krea key", url: "", set: false }] }),
    ],
  },
  web: {
    active: null,
    backends: { search: "firecrawl", extract: "firecrawl" },
    providers: [service({ name: "Exa · Free (keyless)", label: "Exa", badge: "free · no key" })],
  },
};

const picked: ToolsState = {
  ...fresh,
  image: {
    active: "OpenAI",
    model: { current: "gpt-image-2-medium", options: [{ id: "gpt-image-2-low", label: "GPT Image 2 (Low)", detail: "~15s" }, { id: "gpt-image-2-medium", label: "GPT Image 2 (Medium)", detail: "~40s" }] },
    providers: fresh.image.providers.map((p) => (p.name === "OpenAI" ? { ...p, status: "ready", active: true, keys: p.keys.map((k) => ({ ...k, set: true })) } : p)),
  },
};

vi.mock("@/lib/bridge", () => ({
  fetchTools: vi.fn(async () => fresh),
  patchTools: vi.fn(async () => picked),
  testTool: vi.fn(async () => ({ ok: true, image: { path: "E:/synthetic/test.png", name: "test.png", kind: "image", mime: "image/png" } })),
}));

import { patchTools, testTool } from "@/lib/bridge";
import { ToolsPage } from "@/components/settings/tools";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it("says plainly that images aren't set up, and keeps the rest of the services folded away", async () => {
  render(<ToolsPage />);
  expect(await screen.findByText(/can’t make images yet/)).toBeTruthy();
  const list = screen.getByRole("radiogroup", { name: "Image services" });
  expect(within(list).queryByText("Krea")).toBeNull();
  fireEvent.click(within(list).getByRole("button", { name: /More services \(1\)/ }));
  expect(within(list).getByText("Krea")).toBeTruthy();
  // A service that needs a sign-in in Hermes can't be picked here, and says why.
  const signIn = within(list).getByRole("radio", { name: /ChatGPT sign-in/ });
  expect((signIn as HTMLButtonElement).disabled).toBe(true);
  expect(within(signIn).getByText("Needs a ChatGPT sign-in in Hermes")).toBeTruthy();
  // With no service chosen yet there is nothing to test.
  expect((screen.getByRole("button", { name: "Make a test image" }) as HTMLButtonElement).disabled).toBe(true);
});

it("a key and the pick go together, then the model list and the test appear", async () => {
  render(<ToolsPage />);
  fireEvent.click(await screen.findByRole("radio", { name: /OpenAI API key/ }));
  expect(screen.getByText("Get a key at platform.openai.com")).toBeTruthy();
  const save = screen.getByRole("button", { name: "Save and use" }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("OpenAI API key: OpenAI key"), { target: { value: " sk-synthetic " } });
  fireEvent.click(save);
  await waitFor(() => expect(patchTools).toHaveBeenCalledWith({ tool: "image", provider: "OpenAI", keys: { OPENAI_API_KEY: "sk-synthetic" } }));
  expect(await screen.findByText(/makes images with/)).toBeTruthy();
  const model = screen.getByRole("combobox") as HTMLSelectElement;
  expect(model.value).toBe("gpt-image-2-medium");
  fireEvent.change(model, { target: { value: "gpt-image-2-low" } });
  await waitFor(() => expect(patchTools).toHaveBeenCalledWith({ tool: "image", model: "gpt-image-2-low" }));
  fireEvent.click(screen.getByRole("button", { name: "Make a test image" }));
  await waitFor(() => expect(testTool).toHaveBeenCalledWith("image"));
  expect(await screen.findByRole("img")).toBeTruthy();
});

it("a free search service is picked in one tap", async () => {
  render(<ToolsPage />);
  expect(await screen.findByText(/picks a search service on its own/)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: /Exa/ }));
  await waitFor(() => expect(patchTools).toHaveBeenCalledWith({ tool: "web", provider: "Exa · Free (keyless)" }));
});
