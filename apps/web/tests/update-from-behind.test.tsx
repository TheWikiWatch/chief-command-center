import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { UpdateCard, UpdatesPanel } from "@/components/updates/update-card";
import { UpdateHistorySheet } from "@/components/updates/update-history";
import type { UpdateState } from "@/lib/desktop";

const release = { version: "0.1.27", published: "", notes: "Older.", package: { file: "x.msix", bytes: 1, sha256: "a".repeat(64) }, hermes: { base_version: "2026.9.24", commit: "c" } };

function shell(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const updates = {
    state: async (): Promise<UpdateState> => ({ status: "up-to-date", checkedAt: 1 }),
    check: async () => ({ status: "up-to-date", checkedAt: 1 }),
    prepare: async () => ({ status: "idle" }),
    restart: async () => ({ status: "idle" }),
    skip: async () => ({ status: "idle" }),
    feed: async () => "github:me/chief-releases",
    setFeed: async () => ({ status: "idle" }),
    hasKey: async () => true,
    keyStatus: async () => ({ saved: true, refused: true }),
    setKey: async (k: string) => (calls.push(`setKey ${JSON.stringify(k)}`), { status: "idle" }),
    installVersion: async (v: string) => (calls.push(`install ${v}`), { status: "preparing", release, step: "stage", pct: 0 }),
    onState: () => () => undefined,
    ...over,
  };
  (window as unknown as { chiefDesktop: unknown }).chiefDesktop = { updates };
  return calls;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { chiefDesktop?: unknown }).chiefDesktop;
});

it("a key GitHub refused is explained, and Remove key deletes it", async () => {
  const calls = shell();
  render(<UpdatesPanel />);
  expect(await screen.findByText(/GitHub no longer accepts the saved key/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
  await waitFor(() => expect(calls).toEqual(['setKey ""']));
  expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
});

it("an older version chosen from the history says so on the card", async () => {
  shell({ state: async () => ({ status: "ready", release, file: "x.msix", staged: true, older: true }) });
  render(<UpdateCard />);
  expect(await screen.findByText("Older version 0.1.27 is ready")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Restart into 0.1.27" })).toBeTruthy();
});

it("the history offers any published version, asks once, and starts getting it ready", async () => {
  const calls = shell();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        ok: true,
        available: true,
        current: "0.1.30",
        releases: [
          { version: "0.1.31", published: "", notes: "Newer.", hermes: "2026.9.24" },
          { version: "0.1.30", published: "", notes: "Current.", hermes: "2026.9.24" },
          { version: "0.1.27", published: "", notes: "Older.", hermes: "2026.9.24" },
        ],
        installs: [],
      }),
    ),
  );
  const closed = vi.fn();
  render(<UpdateHistorySheet open onClose={closed} />);
  const buttons = await screen.findAllByRole("button", { name: "Install this version" });
  expect(buttons).toHaveLength(2); // not on the running version
  fireEvent.click(buttons[1]);
  expect(screen.getByText(/Go back to 0\.1\.27\? Your setup is backed up first/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Go back to 0.1.27" }));
  await waitFor(() => expect(calls).toEqual(["install 0.1.27"]));
  expect(closed).toHaveBeenCalled();
});

it("an older app without the feature shows no install buttons", async () => {
  shell({ installVersion: undefined });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, available: true, current: "0.1.30", releases: [{ version: "0.1.27", published: "", notes: "x", hermes: "" }], installs: [] })));
  render(<UpdateHistorySheet open onClose={() => undefined} />);
  await screen.findByText("0.1.27");
  expect(screen.queryByRole("button", { name: "Install this version" })).toBeNull();
});
