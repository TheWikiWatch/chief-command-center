import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const EFFORT = { ok: true, provider: "openrouter", model: "deepseek/deepseek-chat", effort: "", general: "medium", levels: ["none", "low", "medium", "high", "max"] };

async function openPicker() {
  const trigger = await screen.findByRole("button", { name: "Model" });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.click(trigger);
}

it("the model picker lists every connected provider's models and re-pins the bot", async () => {
  const changed = vi.fn();
  const calls = route({ "fleet/models": () => MODELS, "fleet/model": () => ({ ok: true }), "fleet/effort": () => EFFORT });
  render(<ModelPicker profile="research-desk" provider="openrouter" model="deepseek/deepseek-chat" onChanged={changed} />);
  await openPicker();
  const local = screen.getByRole("group", { name: "Local model" });
  fireEvent.click(within(local).getByRole("button", { name: /^tiny-local/ }));
  await screen.findByText("Saved. It answers with this model from the next message.");
  expect(calls.find((c) => c.path === "fleet/model")?.body).toEqual({ profile: "research-desk", provider: "local-model", model: "tiny-local", confirm: false });
  expect(changed).toHaveBeenCalled();
});

it("an expensive model asks first and only pins on 'Use it anyway'", async () => {
  const calls = route({
    "fleet/models": () => MODELS,
    "fleet/model": (b) => (b.confirm ? { ok: true } : { ok: false, confirm: "This model costs about $75 per million output tokens." }),
    "fleet/effort": () => EFFORT,
  });
  render(<ModelPicker profile="chief" provider="openrouter" model="deepseek/deepseek-chat" />);
  await openPicker();
  fireEvent.click(screen.getByRole("button", { name: /^anthropic\/claude-opus/ }));
  await screen.findByText(/costs about \$75/);
  fireEvent.click(screen.getByRole("button", { name: "Use it anyway" }));
  await screen.findByText("Saved. It answers with this model from the next message.");
  expect(calls.filter((c) => c.path === "fleet/model").map((c) => c.body.confirm)).toEqual([false, true]);
});

it("favourites come first, plans say what's left, and a thinking model gets a level", async () => {
  const models = {
    ...MODELS,
    groups: [
      {
        ...MODELS.groups[0],
        caps: { "deepseek/deepseek-chat": { reasoning: true, fast: false, canDisable: false }, "anthropic/claude-opus": { reasoning: true, fast: true, canDisable: true } },
        usage: { left: 8, resetsAt: null, window: "week" },
      },
      { ...MODELS.groups[1], limit: { scope: "account", until: "2099-01-01T15:00:00Z" } },
    ],
    favorites: [{ provider: "openrouter", model: "anthropic/claude-opus" }],
  };
  const calls = route({
    "fleet/models": () => models,
    "fleet/effort": () => EFFORT,
    "fleet/favorite": (b) => ({ ok: true, favorites: b.on ? [{ provider: b.provider, model: b.model }] : [] }),
  });
  render(<ModelPicker profile="chief" provider="openrouter" model="deepseek/deepseek-chat" />);
  await openPicker();
  expect(screen.getAllByText("8% left")[0]).toBeInTheDocument(); // under 10%: shown on the trigger too
  const favs = screen.getByRole("group", { name: "Favourites" });
  expect(within(favs).getByRole("button", { name: /^anthropic\/claude-opus/ })).toBeInTheDocument();
  expect(within(screen.getByRole("group", { name: "Local model" })).getByText(/rate limited until/)).toBeInTheDocument();
  fireEvent.click(within(favs).getByRole("button", { name: "Unstar anthropic/claude-opus" }));
  await waitFor(() => expect(calls.find((c) => c.path === "fleet/favorite")?.body).toEqual({ provider: "openrouter", model: "anthropic/claude-opus", on: false }));
  await waitFor(() => expect(screen.queryByRole("group", { name: "Favourites" })).toBeNull());

  const thinking = await screen.findByLabelText("Thinking");
  expect(within(thinking).getByRole("option", { name: "Default (Medium, the bot's general level)" })).toBeInTheDocument();
  expect(within(thinking).queryByRole("option", { name: "Off" })).toBeNull(); // this model can't switch reasoning off
  route({ "fleet/models": () => models, "fleet/effort": (b) => ({ ...EFFORT, effort: String(b.effort ?? "") }) });
  fireEvent.change(thinking, { target: { value: "high" } });
  await waitFor(() => expect((screen.getByLabelText("Thinking") as HTMLSelectElement).value).toBe("high"));
});

it("helpers use the bot's own model until another is picked", async () => {
  let helpers = { ok: true, provider: "", model: "" };
  const calls = route({
    "fleet/models": () => MODELS,
    "fleet/effort": () => EFFORT,
    "fleet/helpers": (b) => (b.provider !== undefined ? (helpers = { ok: true, provider: String(b.provider), model: String(b.model) }) : helpers),
  });
  render(<ModelPicker profile="research-desk" provider="openrouter" model="deepseek/deepseek-chat" />);
  const select = (await screen.findByLabelText("Helpers use")) as HTMLSelectElement;
  expect(select.value).toBe("");
  expect(within(select).getByRole("option", { name: "The same model" })).toBeInTheDocument();
  fireEvent.change(select, { target: { value: "local-model\u0000tiny-local" } });
  await waitFor(() =>
    expect(calls.find((c) => c.path === "fleet/helpers" && c.body.provider !== undefined)?.body).toEqual({ profile: "research-desk", provider: "local-model", model: "tiny-local" }),
  );
  await waitFor(() => expect((screen.getByLabelText("Helpers use") as HTMLSelectElement).value).toBe("local-model\u0000tiny-local"));
});

it("a Nous plan shows its allowances, the plan's picks first, Free and Large, and what a full one stops", async () => {
  const now = Date.now() / 1000;
  const models = {
    ok: true,
    current: { provider: "nous", model: "hermes-large" },
    groups: [
      {
        provider: "nous",
        name: "Nous Portal",
        kind: "external",
        models: ["hermes-large", "hermes-free", "hermes-small"],
        plan: {
          name: "Plus",
          gauges: [
            { label: "day", title: "", used: 40, full: false, resetsAt: now + 3 * 3600, scope: "all" },
            { label: "week", title: "", used: 100, full: true, resetsAt: now + 21 * 3600, scope: "all" },
          ],
          paused: null,
          creditsPay: false,
          featured: ["hermes-small"],
          large: ["hermes-large"],
          free: ["hermes-free"],
        },
      },
    ],
  };
  route({ "fleet/models": () => models, "fleet/effort": () => ({ ...EFFORT, provider: "nous", model: "hermes-large" }) });
  render(<ModelPicker profile="chief" provider="nous" model="hermes-large" />);
  // Closed: the allowances, and the current (Large) model is stopped.
  expect(await screen.findByRole("meter", { name: "This week: 100% used" })).toBeInTheDocument();
  expect(screen.getByRole("meter", { name: "Today: 40% used" })).toBeInTheDocument();
  expect(screen.getByText(/^limit reached · resets in 21h$/)).toBeInTheDocument();
  expect(screen.getByText("Weekly limit reached · resets in 21h · only Free models until then")).toBeInTheDocument();
  await openPicker();
  const group = screen.getByRole("group", { name: "Nous Portal" });
  const rows = within(group).getAllByRole("button", { name: /^hermes-/ });
  expect(rows.map((r) => r.textContent?.split(/(?=Free|Large)/)[0].replace(/stopped.*/, "").trim())).toEqual(["hermes-small", "hermes-large", "hermes-free"]);
  expect(within(rows[1]).getByText("Large")).toBeInTheDocument();
  expect(within(rows[1]).getByText(/stopped until the limit resets/)).toBeInTheDocument();
  expect(within(rows[2]).getByText("Free")).toBeInTheDocument();
  expect(within(rows[2]).queryByText(/stopped/)).toBeNull(); // a full allowance never stops a Free model
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
  fireEvent.click(screen.getByRole("button", { name: "Ask Nova" }));
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
  expect(screen.getByText("In use by Nova")).toBeInTheDocument();
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
