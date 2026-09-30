import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Onboarding } from "@/components/onboarding/onboarding";

const CATALOG = {
  ok: true,
  provider: "",
  model: "",
  status: { ready: false, provider: "", model: "", error: "No model is chosen yet." },
  providers: [{ slug: "custom", name: "custom", kind: "custom", authType: "api_key", keyEnv: "", connected: false, current: false, models: [], featured: [], warning: "" }],
};
const BRAIN = { ok: true, configured: false, path: "", exists: false, wiki_path: "", mode: null, skill_installed: false, default_path: "C:\\Users\\me\\Documents\\Second Brain" };
const VOICE = { ok: true, default: "base", models: [{ id: "base", label: "Standard", bytes: 147_882_941, installed: false, source: "" }], job: null, stt: { provider: "local", enabled: true, local: true, ready: false } };

const HANDLERS: Record<string, unknown> = {
  "setup/providers": CATALOG,
  "setup/endpoint/check": { ok: true, reachable: true, error: "", models: ["llama3.2"], baseUrl: "http://127.0.0.1:11434/v1" },
  "setup/endpoint/save": { ok: true },
  "setup/test": { ok: true, reply: "ready" },
  "setup/status": { ok: true, ready: true, provider: "Local model", model: "llama3.2", error: "" },
  "setup/second-brain": BRAIN,
  "setup/soul/seed": { ok: true, seeded: true },
  "voice/model": VOICE,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("walks model → Second Brain → Check my system; optional steps can be skipped; the default SOUL is seeded once", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://127.0.0.1:3100").pathname.replace("/api/bridge/", "");
      calls.push(path);
      return Response.json(HANDLERS[path] ?? { ok: false, error: `no handler for ${path}` });
    }),
  );
  const finished = vi.fn();
  render(<Onboarding onLater={() => undefined} onFinished={finished} />);
  const steps = screen.getByRole("list", { name: "Steps" });
  expect(steps.textContent).toMatch(/Connect a model.*Your Second Brain.*Check my system/);
  await waitFor(() => expect(calls.filter((c) => c === "setup/soul/seed")).toHaveLength(1));

  // 1. A working model is required before Continue.
  expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(await screen.findByRole("button", { name: /Local or custom endpoint/ }));
  fireEvent.change(screen.getByPlaceholderText("http://127.0.0.1:11434/v1"), { target: { value: "http://127.0.0.1:11434" } });
  fireEvent.click(screen.getByRole("button", { name: "Check the endpoint" }));
  fireEvent.click(await screen.findByRole("button", { name: "Use llama3.2" }));
  await screen.findByRole("heading", { name: "Connected" });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));

  // 2. The Second Brain step can be skipped.
  expect(await screen.findByRole("heading", { name: "Your Second Brain" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

  // 3. Check my system: nothing downloads without a tap; Skip finishes.
  expect(await screen.findByRole("heading", { name: "Check my system" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: "Download" })).toBeTruthy();
  expect(calls).not.toContain("voice/model/download");
  fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
  expect(finished).toHaveBeenCalledOnce();
  expect(finished.mock.calls[0][0]).toMatchObject({ ready: true, model: "llama3.2" });
  expect(calls.filter((c) => c === "setup/soul/seed")).toHaveLength(1);
});
