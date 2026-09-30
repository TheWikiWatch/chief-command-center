import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ConnectModel } from "@/components/onboarding/connect-model";
import { useNeedsOnboarding } from "@/components/onboarding/onboarding";

type Handler = (body: Record<string, unknown>) => unknown;

const CATALOG = {
  ok: true,
  provider: "",
  model: "",
  status: { ready: false, provider: "", model: "", error: "No model is chosen yet." },
  providers: [
    { slug: "openrouter", name: "OpenRouter", kind: "key", authType: "api_key", keyEnv: "OPENROUTER_API_KEY", connected: false, current: false, models: [], featured: [], warning: "" },
    { slug: "deepseek", name: "DeepSeek", kind: "key", authType: "api_key", keyEnv: "DEEPSEEK_API_KEY", connected: false, current: false, models: [], featured: [], warning: "" },
    { slug: "nous", name: "Nous Portal", kind: "external", authType: "oauth_device_code", keyEnv: "", connected: false, current: false, models: [], featured: [], warning: "" },
    { slug: "custom", name: "custom", kind: "custom", authType: "api_key", keyEnv: "", connected: false, current: false, models: [], featured: [], warning: "" },
  ],
};

function route(handlers: Record<string, Handler>) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://127.0.0.1:3100");
    const path = url.pathname.replace("/api/bridge/setup/", "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : Object.fromEntries(url.searchParams);
    calls.push({ path, body });
    const handler = handlers[path];
    if (!handler) return Response.json({ ok: false, error: `no handler for ${path}` }, { status: 404 });
    return Response.json(handler(body));
  });
  vi.stubGlobal("fetch", fetcher);
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("connects a key provider: key, recommended model, one test message", async () => {
  const done = vi.fn();
  const calls = route({
    providers: () => CATALOG,
    key: () => ({ ok: true, provider: "deepseek" }),
    models: () => ({ ok: true, provider: "deepseek", models: ["deepseek-chat", "deepseek-reasoner"], featured: [], recommended: "deepseek-chat", connected: true }),
    model: () => ({ ok: true }),
    test: () => ({ ok: true, reply: "ready" }),
    status: () => ({ ok: true, ready: true, provider: "deepseek", model: "deepseek-chat", error: "" }),
  });
  render(<ConnectModel onDone={done} />);
  fireEvent.click(await screen.findByRole("button", { name: /DeepSeek/ }));
  fireEvent.change(screen.getByPlaceholderText("Paste your key"), { target: { value: "sk-test" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  const select = await screen.findByRole("combobox");
  expect((select as HTMLSelectElement).value).toBe("deepseek-chat");
  fireEvent.click(screen.getByRole("button", { name: "Use deepseek-chat" }));
  expect(await screen.findByRole("heading", { name: "Connected" })).toBeInTheDocument();
  expect(screen.getByText(/The model answered “ready”\./)).toBeInTheDocument();
  expect(done).toHaveBeenCalledWith(expect.objectContaining({ ready: true, model: "deepseek-chat" }));
  expect(calls.find((c) => c.path === "key")?.body).toEqual({ provider: "deepseek", key: "sk-test" });
  expect(calls.find((c) => c.path === "model")?.body).toEqual({ provider: "deepseek", model: "deepseek-chat", confirm: false });
  // The key never appears on screen once sent.
  expect(document.body.textContent).not.toContain("sk-test");
});

it("a rejected key keeps the step on screen with the reason and a way to retry", async () => {
  route({
    providers: () => CATALOG,
    key: () => ({ ok: true }),
    models: () => ({ ok: true, provider: "openrouter", models: ["a/b"], featured: [], recommended: "a/b", connected: true }),
    model: () => ({ ok: true }),
    test: () => ({ ok: false, code: "rejected", error: "The provider rejected the key." }),
  });
  render(<ConnectModel />);
  fireEvent.click(await screen.findByRole("button", { name: /OpenRouter/ }));
  fireEvent.change(screen.getByPlaceholderText("Paste your key"), { target: { value: "bad" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  fireEvent.click(await screen.findByRole("button", { name: "Use a/b" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("The provider rejected the key.");
  expect(screen.getByRole("heading", { name: "Choose a model" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  // Back returns to the key step to paste a different key.
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(await screen.findByRole("heading", { name: "Connect OpenRouter" })).toBeInTheDocument();
});

it("an expensive model asks before it is used", async () => {
  let asked = 0;
  const calls = route({
    providers: () => CATALOG,
    key: () => ({ ok: true }),
    models: () => ({ ok: true, provider: "openrouter", models: ["big/model"], featured: [], recommended: "big/model", connected: true }),
    model: (body) => (body.confirm ? { ok: true } : (asked++, { ok: false, confirm: "big/model costs $75 per million output tokens." })),
    test: () => ({ ok: true, reply: "ready" }),
    status: () => ({ ok: true, ready: true, provider: "openrouter", model: "big/model", error: "" }),
  });
  render(<ConnectModel />);
  fireEvent.click(await screen.findByRole("button", { name: /OpenRouter/ }));
  fireEvent.change(screen.getByPlaceholderText("Paste your key"), { target: { value: "k" } });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
  fireEvent.click(await screen.findByRole("button", { name: "Use big/model" }));
  expect(await screen.findByText(/costs \$75/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Use it anyway" }));
  expect(await screen.findByRole("heading", { name: "Connected" })).toBeInTheDocument();
  expect(asked).toBe(1);
  expect(calls.filter((c) => c.path === "model").map((c) => c.body.confirm)).toEqual([false, true]);
});

it("connects a local endpoint without a key", async () => {
  const calls = route({
    providers: () => CATALOG,
    "endpoint/check": () => ({ ok: true, reachable: true, error: "", models: ["llama3.2"], baseUrl: "http://127.0.0.1:11434/v1" }),
    "endpoint/save": () => ({ ok: true }),
    test: () => ({ ok: true, reply: "ready" }),
    status: () => ({ ok: true, ready: true, provider: "local-model", model: "llama3.2", error: "" }),
  });
  render(<ConnectModel />);
  fireEvent.click(await screen.findByRole("button", { name: /Local or custom endpoint/ }));
  fireEvent.change(screen.getByPlaceholderText("http://127.0.0.1:11434/v1"), { target: { value: "http://127.0.0.1:11434" } });
  fireEvent.click(screen.getByRole("button", { name: "Check the endpoint" }));
  fireEvent.click(await screen.findByRole("button", { name: "Use llama3.2" }));
  expect(await screen.findByRole("heading", { name: "Connected" })).toBeInTheDocument();
  expect(calls.find((c) => c.path === "endpoint/save")?.body).toEqual({ name: "Local model", base_url: "http://127.0.0.1:11434/v1", model: "llama3.2", api_key: "" });
});

it("an unreachable endpoint says so", async () => {
  route({
    providers: () => CATALOG,
    "endpoint/check": () => ({ ok: false, reachable: false, error: "Could not reach http://127.0.0.1:9/models.", models: [], baseUrl: "" }),
  });
  render(<ConnectModel />);
  fireEvent.click(await screen.findByRole("button", { name: /Local or custom endpoint/ }));
  fireEvent.change(screen.getByPlaceholderText("http://127.0.0.1:11434/v1"), { target: { value: "http://127.0.0.1:9" } });
  fireEvent.click(screen.getByRole("button", { name: "Check the endpoint" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach");
});

it("sign-in providers are listed but not offered as key providers", async () => {
  route({ providers: () => CATALOG });
  render(<ConnectModel />);
  await screen.findByRole("button", { name: /OpenRouter/ });
  expect(screen.queryByRole("button", { name: /Nous Portal/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sign-in providers" }));
  expect(screen.getByText(/Nous Portal/)).toBeInTheDocument();
});

function Probe({ connected }: { connected: boolean }) {
  const state = useNeedsOnboarding(connected);
  return <p>{state.needed ? "onboarding" : "dashboard"}</p>;
}

it("onboarding shows only while the chief has no working model", async () => {
  sessionStorage.clear();
  route({ status: () => ({ ok: true, ready: false, provider: "", model: "", error: "No model is chosen yet." }) });
  const view = render(<Probe connected />);
  expect(await screen.findByText("onboarding")).toBeInTheDocument();
  view.unmount();
  route({ status: () => ({ ok: true, ready: true, provider: "deepseek", model: "deepseek-chat", error: "" }) });
  render(<Probe connected />);
  await act(async () => undefined);
  await waitFor(() => expect(screen.getByText("dashboard")).toBeInTheDocument());
});
