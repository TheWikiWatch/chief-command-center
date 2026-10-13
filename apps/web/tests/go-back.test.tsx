import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { UpdatesGroup } from "@/components/settings/backup";

afterEach(() => {
  cleanup();
  delete (window as unknown as { chiefDesktop?: unknown }).chiefDesktop;
});

function desktopWith(options: { version: string; published: string; file: string }[]) {
  const rollback = vi.fn(async () => ({ status: "restarting", step: "Closing Chief…" }));
  const updates = {
    state: async () => ({ status: "up-to-date", checkedAt: 0 }),
    check: vi.fn(),
    prepare: vi.fn(),
    restart: vi.fn(),
    skip: vi.fn(),
    feed: async () => "",
    setFeed: vi.fn(),
    onState: () => () => undefined,
    rollbackOptions: async () => options,
    rollback,
  };
  (window as unknown as { chiefDesktop: unknown }).chiefDesktop = { updates };
  return rollback;
}

it("offers the previous version when its package is kept; the app's own dialog does the asking", async () => {
  const rollback = desktopWith([{ version: "1.0.0", published: "2026-09-01T00:00:00Z", file: "x" }]);
  render(<UpdatesGroup />);
  expect(await screen.findByText(/backed up first/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Go back…" }));
  await waitFor(() => expect(rollback).toHaveBeenCalledWith("1.0.0"));
});

it("a no in the app's dialog changes nothing and shows no error", async () => {
  const rollback = desktopWith([{ version: "1.0.0", published: "2026-09-01T00:00:00Z", file: "x" }]);
  rollback.mockImplementation(async () => ({ status: "error", error: "x", cancelled: true }) as never);
  render(<UpdatesGroup />);
  fireEvent.click(await screen.findByRole("button", { name: "Go back…" }));
  await waitFor(() => expect(rollback).toHaveBeenCalled());
  expect(screen.queryByText("x")).toBeNull();
  expect(screen.getByRole("button", { name: "Go back…" })).toBeEnabled();
});

it("says nothing when no earlier version is kept", async () => {
  desktopWith([]);
  render(<UpdatesGroup />);
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByRole("button", { name: "Go back…" })).toBeNull();
});
