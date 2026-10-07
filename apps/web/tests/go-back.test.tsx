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

it("offers the previous version when its package is kept, and asks before going back", async () => {
  const rollback = desktopWith([{ version: "1.0.0", published: "2026-09-01T00:00:00Z", file: "x" }]);
  render(<UpdatesGroup />);
  fireEvent.click(await screen.findByRole("button", { name: "Go back…" }));
  expect(screen.getByText(/backed up first/)).toBeInTheDocument();
  expect(rollback).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Go back to 1.0.0" }));
  await waitFor(() => expect(rollback).toHaveBeenCalledWith("1.0.0"));
});

it("says nothing when no earlier version is kept", async () => {
  desktopWith([]);
  render(<UpdatesGroup />);
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByRole("button", { name: "Go back…" })).toBeNull();
});
