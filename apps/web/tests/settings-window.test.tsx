import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/bridge", () => ({
  fetchSettings: vi.fn(async () => ({ stt: { providers: [] }, tts: { providers: [], voices: [] } })),
  patchSettings: vi.fn(async () => ({})),
  renameProfile: vi.fn(async (_profile: string, name: string, role: string) => ({ ok: true, title: `${name} - ${role}`, name, role, soul: "updated" })),
}));
vi.mock("@/lib/web-push", () => ({ pushCapability: vi.fn(async () => ({ available: false })), enableWebPush: vi.fn(), pushStatus: vi.fn(async () => "off") }));

import { NameEditor } from "@/components/persona/name-editor";
import { SettingsPanel } from "@/components/settings-panel";
import { renameProfile } from "@/lib/bridge";

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "http://127.0.0.1:3100").pathname;
      if (path === "/api/bridge/about") return Response.json({ ok: true, toolkit: { name: "obsidian-second-brain", version: "0.17.0" } });
      return Response.json({ ok: false, error: "not in this test" });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("desktop: a sidebar of categories; choosing one shows its page and is remembered", async () => {
  render(<SettingsPanel open phone={false} onClose={() => {}} />);
  const nav = await screen.findByRole("navigation", { name: "Settings" });
  expect(nav).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "page");
  fireEvent.click(screen.getByRole("button", { name: "About" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "About" })).toHaveAttribute("aria-current", "page"));
  expect(screen.getByText("Versions, licences and credits, and reporting a problem.")).toBeInTheDocument();
  expect(localStorage.getItem("chief-settings-category")).toBe("about");

  cleanup();
  render(<SettingsPanel open phone={false} onClose={() => {}} />);
  expect(await screen.findByRole("button", { name: "About" })).toHaveAttribute("aria-current", "page");
});

it("phone: a list of categories that drills into a page and back", async () => {
  render(<SettingsPanel open phone onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: /Notifications/ }));
  const back = await screen.findByRole("button", { name: "Back to Settings" });
  expect(await screen.findByText("Alerts, sounds and vibration on this device.")).toBeInTheDocument();
  fireEvent.click(back);
  expect(await screen.findByRole("button", { name: /Usage/ })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Back to Settings" })).toBeNull();
});

it("opens at the category it is asked for", async () => {
  render(<SettingsPanel open phone={false} onClose={() => {}} category="usage" />);
  expect(await screen.findByRole("button", { name: "Usage" })).toHaveAttribute("aria-current", "page");
});

it("renames a bot, updating its SOUL unless told not to", async () => {
  const onSaved = vi.fn();
  render(<NameEditor profile="research-desk" name="Sam" role="Researcher" onSaved={onSaved} onCancel={() => {}} />);
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toBeDisabled(); // nothing changed yet
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(save);
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ title: "Ada - Researcher", name: "Ada", role: "Researcher", soul: "updated" }));
  expect(renameProfile).toHaveBeenCalledWith("research-desk", "Ada", "Researcher", false);
});

it("shows why a rename was refused", async () => {
  vi.mocked(renameProfile).mockResolvedValueOnce({ ok: false, error: "A name can't contain ' - '." });
  render(<NameEditor profile="chief" name="Chief" role="" onSaved={() => {}} onCancel={() => {}} />);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "A - B" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("can't contain");
});
