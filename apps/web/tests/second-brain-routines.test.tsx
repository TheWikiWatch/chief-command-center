import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/bridge", () => ({ fetchSettings: vi.fn(async () => ({ stt: { providers: [] }, tts: { providers: [], voices: [] } })), patchSettings: vi.fn() }));
vi.mock("@/lib/web-push", () => ({ pushCapability: vi.fn(async () => ({ available: false })), enableWebPush: vi.fn(), pushStatus: vi.fn(async () => "off") }));

import { SettingsPanel } from "@/components/settings-panel";
import { permittedOperation } from "@/lib/proxy-policy";

const ROUTINES = [
  { id: "morning", title: "Morning note", about: "Today's daily note.", exists: true, enabled: true, time: "08:00", days: "Every day", next_run: null, last_run: null, last_status: null },
  { id: "nightly", title: "Nightly tidy", about: "Closes the day.", exists: true, enabled: true, time: "22:00", days: "Every day", next_run: null, last_run: null, last_status: null },
];

function route() {
  const posts: Record<string, unknown>[] = [];
  let items = ROUTINES.map((r) => ({ ...r }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "http://127.0.0.1:3100").pathname;
      if (path === "/api/bridge/setup/second-brain")
        return Response.json({ ok: true, configured: true, path: "C:/Notes", exists: true, mode: "new", wiki_path: "", skill_installed: true, default_path: "" });
      if (path === "/api/bridge/second-brain/routines") {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { id: string; enabled?: boolean; time?: string };
          posts.push(body);
          items = items.map((r) => (r.id === body.id ? { ...r, ...(body.enabled !== undefined ? { enabled: body.enabled } : {}), ...(body.time ? { time: body.time } : {}) } : r));
        }
        return Response.json({ ok: true, routines: items });
      }
      return Response.json({ ok: false }, { status: 404 });
    }),
  );
  return posts;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("lists the Second Brain's routines; each turns off and moves to another time", async () => {
  const posts = route();
  render(<SettingsPanel open phone={false} onClose={() => {}} />);
  const nightly = await screen.findByRole("switch", { name: "Nightly tidy on" });
  fireEvent.click(nightly);
  await waitFor(() => expect(screen.getByRole("switch", { name: "Nightly tidy off" })).toHaveAttribute("aria-checked", "false"));
  expect(posts[0]).toEqual({ id: "nightly", enabled: false });

  const time = screen.getByLabelText("Morning note time");
  fireEvent.change(time, { target: { value: "07:15" } });
  expect(posts).toHaveLength(1); // nothing saved while typing
  fireEvent.blur(time);
  await waitFor(() => expect(posts[1]).toEqual({ id: "morning", time: "07:15" }));
  expect(within(time.closest("li")!).getByText("Morning note")).toBeInTheDocument();
});

it("the proxy forwards the routines and nothing else under second-brain", () => {
  expect(permittedOperation("bridge", "GET", ["second-brain", "routines"])).toBe(true);
  expect(permittedOperation("bridge", "POST", ["second-brain", "routines"])).toBe(true);
  expect(permittedOperation("bridge", "POST", ["second-brain", "delete"])).toBe(false);
});
