import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ModelPicker } from "@/components/fleet/model-picker";
import { ModelsKeys } from "@/components/fleet/models-keys";
import { TeamBody } from "@/components/fleet/team-sheet";
import { permittedOperation } from "@/lib/proxy-policy";

type Handler = (body: Record<string, unknown>) => unknown;

/** Routes /api/bridge/<path> to handlers; records each call. */
function route(handlers: Record<string, Handler>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://127.0.0.1:3100");
      const path = url.pathname.replace("/api/bridge/", "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : Object.fromEntries(url.searchParams);
      calls.push({ path, body });
      const handler = handlers[path];
      if (!handler) return Response.json({ ok: false, error: `no handler for ${path}` }, { status: 404 });
      return Response.json(handler(body));
    }),
  );
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MODELS = {
  ok: true,
  current: { provider: "openrouter", model: "deepseek/deepseek-chat" },
  groups: [
    { provider: "openrouter", name: "OpenRouter", kind: "key", models: ["deepseek/deepseek-chat", "anthropic/claude-opus"] },
    { provider: "local-model", name: "Local model", kind: "custom", models: ["tiny-local"] },
  ],
};

it("the model picker lists every connected provider's models and re-pins the bot", async () => {
  const changed = vi.fn();
  const calls = route({ "fleet/models": () => MODELS, "fleet/model": () => ({ ok: true }) });
  render(<ModelPicker profile="research-desk" provider="openrouter" model="deepseek/deepseek-chat" onChanged={changed} />);
  const select = await screen.findByLabelText("Model");
  await waitFor(() => expect(select).not.toBeDisabled());
  expect(screen.getByRole("option", { name: "tiny-local" })).toBeInTheDocument();
  expect(screen.getByRole("group", { name: "Local model" })).toBeInTheDocument();
  fireEvent.change(select, { target: { value: "local-model\u0001tiny-local" } });
  await screen.findByText("Saved. It applies from the next conversation.");
  expect(calls.find((c) => c.path === "fleet/model")?.body).toEqual({ profile: "research-desk", provider: "local-model", model: "tiny-local", confirm: false });
  expect(changed).toHaveBeenCalled();
});

it("an expensive model asks first and only pins on 'Use it anyway'", async () => {
  const calls = route({
    "fleet/models": () => MODELS,
    "fleet/model": (b) => (b.confirm ? { ok: true } : { ok: false, confirm: "This model costs about $75 per million output tokens." }),
  });
  render(<ModelPicker profile="chief" provider="openrouter" model="deepseek/deepseek-chat" />);
  const select = await screen.findByLabelText("Model");
  await waitFor(() => expect(select).not.toBeDisabled());
  fireEvent.change(select, { target: { value: "openrouter\u0001anthropic/claude-opus" } });
  await screen.findByText(/costs about \$75/);
  fireEvent.click(screen.getByRole("button", { name: "Use it anyway" }));
  await screen.findByText("Saved. It applies from the next conversation.");
  expect(calls.filter((c) => c.path === "fleet/model").map((c) => c.body.confirm)).toEqual([false, true]);
});

it("Team: retired bots restore, and removing for good needs a second confirmation", async () => {
  let archives = [{ id: "research-desk-20260930", title: "Sam - Researcher", description: "", retired_at: "2026-09-30T12:00:00Z", model: { provider: "", model: "" } }];
  const calls = route({
    fleet: () => ({ ok: true, workers: [], archives }),
    "fleet/restore": () => {
      archives = [];
      return { ok: true };
    },
    "fleet/archive/remove": () => ({ ok: true }),
  });
  render(<TeamBody onAskChief={vi.fn(async () => undefined)} />);
  await screen.findByText("Sam - Researcher");
  fireEvent.click(screen.getByRole("button", { name: "Remove…" }));
  expect(screen.getByText(/can't be brought back/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
  expect(calls.some((c) => c.path === "fleet/archive/remove")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Restore" }));
  await screen.findByText("Sam - Researcher is back on the team.");
  expect(calls.find((c) => c.path === "fleet/restore")?.body).toEqual({ archive_id: "research-desk-20260930" });
  await screen.findByText(/No retired bots/);
});

it("Team: proposing a specialist asks the chief to interview and wait for sign-off", async () => {
  route({ fleet: () => ({ ok: true, workers: [], archives: [] }) });
  const ask = vi.fn(async (_text: string) => undefined);
  render(<TeamBody onAskChief={ask} />);
  fireEvent.change(screen.getByLabelText("What should the new specialist do?"), { target: { value: "watch supplier invoices" } });
  fireEvent.click(screen.getByRole("button", { name: "Ask Chief" }));
  await waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
  const text = ask.mock.calls[0][0];
  expect(text).toContain("watch supplier invoices");
  expect(text).toContain("fleet-builder");
  expect(text).toMatch(/before you mint/);
});

const PROVIDERS = {
  ok: true,
  provider: "openrouter",
  model: "deepseek/deepseek-chat",
  status: { ready: true, provider: "openrouter", model: "deepseek/deepseek-chat", error: "" },
  providers: [
    { slug: "openrouter", name: "OpenRouter", kind: "key", authType: "api_key", keyEnv: "OPENROUTER_API_KEY", connected: true, current: true, models: ["a"], featured: [], warning: "", keySaved: true },
    { slug: "deepseek", name: "DeepSeek", kind: "key", authType: "api_key", keyEnv: "DEEPSEEK_API_KEY", connected: true, current: false, models: ["b", "c"], featured: [], warning: "", keySaved: true },
    { slug: "copilot", name: "GitHub Copilot", kind: "key", authType: "api_key", keyEnv: "COPILOT_GITHUB_TOKEN", connected: true, current: false, models: ["d"], featured: [], warning: "", keySaved: false },
    { slug: "gemini", name: "Gemini", kind: "key", authType: "api_key", keyEnv: "GEMINI_API_KEY", connected: false, current: false, models: [], featured: [], warning: "" },
  ],
};

it("Models & keys: lists connected providers, protects the chief's, removes another after confirming", async () => {
  const calls = route({ "setup/providers": () => PROVIDERS, "setup/key/remove": () => ({ ok: true }) });
  render(<ModelsKeys />);
  await screen.findByText("DeepSeek");
  expect(screen.queryByText("Gemini")).toBeNull();
  expect(screen.getByText("Chief uses this")).toBeInTheDocument();
  // A sign-in found elsewhere on the PC is shown but can't be removed here.
  expect(screen.getByText(/Signed in on this PC/)).toBeInTheDocument();
  // Only the saved key that the chief isn't using offers removal.
  const remove = screen.getAllByRole("button", { name: "Remove…" });
  expect(remove).toHaveLength(1);
  fireEvent.click(remove[0]);
  fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
  await screen.findByText("DeepSeek's key was removed.");
  expect(calls.find((c) => c.path === "setup/key/remove")?.body).toEqual({ provider: "deepseek" });
});

it("Models & keys: adding a key doesn't switch the chief's model", async () => {
  const calls = route({
    "setup/providers": () => PROVIDERS,
    "setup/key": () => ({ ok: true }),
    "setup/models": () => ({ ok: true, provider: "gemini", models: ["gemini-pro"], featured: [], recommended: "gemini-pro", connected: true }),
  });
  render(<ModelsKeys />);
  fireEvent.click(await screen.findByRole("button", { name: "Add or replace a key" }));
  fireEvent.click(await screen.findByRole("button", { name: /Gemini/ }));
  const field = await screen.findByPlaceholderText("Paste your key");
  fireEvent.change(field, { target: { value: "synthetic-test-value" } });
  fireEvent.submit(field.closest("form")!);
  await screen.findByText("Gemini is connected");
  expect(calls.some((c) => c.path === "setup/model" || c.path === "setup/test")).toBe(false);
});

it("the proxy forwards the fleet and key-removal routes, and nothing else under fleet", () => {
  expect(permittedOperation("bridge", "GET", ["fleet"])).toBe(true);
  expect(permittedOperation("bridge", "GET", ["fleet", "models"])).toBe(true);
  for (const p of [["fleet", "model"], ["fleet", "retire"], ["fleet", "restore"], ["fleet", "archive", "remove"], ["setup", "key", "remove"]]) expect(permittedOperation("bridge", "POST", p)).toBe(true);
  expect(permittedOperation("bridge", "GET", ["fleet", "retire"])).toBe(false);
  expect(permittedOperation("bridge", "POST", ["fleet", "mint"])).toBe(false);
  expect(permittedOperation("bridge", "POST", ["fleet", "delete"])).toBe(false);
});
