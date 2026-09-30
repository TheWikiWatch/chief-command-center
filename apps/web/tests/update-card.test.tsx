import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { UpdateCard } from "@/components/updates/update-card";
import type { UpdateState } from "@/lib/desktop";

const release = { version: "1.1.0", published: "", notes: "Faster startup.", package: { file: "x.msix", bytes: 150_000_000, sha256: "a".repeat(64) }, hermes: { base_version: "2026.10.1", commit: "c" } };

function fakeShell(initial: UpdateState, script: Partial<Record<"download" | "install" | "skip" | "check", (arg?: unknown) => UpdateState>> = {}) {
  let state = initial;
  const listeners = new Set<(s: UpdateState) => void>();
  const set = (s: UpdateState) => {
    state = s;
    listeners.forEach((fn) => fn(s));
    return s;
  };
  const calls: string[] = [];
  const api = {
    state: async () => state,
    check: async () => (calls.push("check"), set(script.check?.() ?? state)),
    download: async () => (calls.push("download"), set(script.download?.() ?? state)),
    install: async (force?: boolean) => (calls.push(`install${force ? " now" : ""}`), set(script.install?.(force) ?? state)),
    skip: async (v: string) => (calls.push(`skip ${v}`), set(script.skip?.(v) ?? state)),
    feed: async () => "E:\\Releases",
    setFeed: async () => state,
    onState: (fn: (s: UpdateState) => void) => (listeners.add(fn), () => listeners.delete(fn)),
  };
  (window as unknown as { chiefDesktop: unknown }).chiefDesktop = { updates: api };
  return calls;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { chiefDesktop?: unknown }).chiefDesktop;
});

it("shows nothing outside the desktop app", () => {
  const { container } = render(<UpdateCard />);
  expect(container.textContent).toBe("");
});

it("offers the update with versions and size; Install downloads, then installs", async () => {
  const calls = fakeShell(
    { status: "available", checkedAt: 1, release },
    { download: () => ({ status: "ready", release, file: "x.msix" }), install: () => ({ status: "installing", release, step: "Backing up…" }) },
  );
  render(<UpdateCard />);
  expect(await screen.findByText("Update available — install?")).toBeTruthy();
  expect(screen.getByText(/Version 1\.1\.0 · Hermes 2026\.10\.1 · 150 MB\. A backup is made first/)).toBeTruthy();
  expect(screen.getByText("Faster startup.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() => expect(calls).toEqual(["download", "install"]));
  expect(await screen.findByText(/Backing up…/)).toBeTruthy();
});

it("while Chief is busy it offers to wait, install now, or later", async () => {
  const onLater = vi.fn();
  const calls = fakeShell({ status: "busy", release, file: "x.msix", reasons: ["Chief is writing a reply."] }, { install: (force) => (force ? { status: "installing", release, step: "Stopping Chief…" } : { status: "busy", release, file: "x.msix", reasons: ["Chief is writing a reply."] }) });
  render(<UpdateCard onLater={onLater} />);
  expect(await screen.findByText(/Chief is writing a reply\. Installing stops/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Later" }));
  expect(onLater).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Install now" }));
  await waitFor(() => expect(calls).toContain("install now"));
});

it("Skip this version, and a failed check shows its reason with Retry", async () => {
  const calls = fakeShell({ status: "available", checkedAt: 1, release }, { skip: () => ({ status: "up-to-date", checkedAt: Date.now() }) });
  render(<UpdateCard />);
  fireEvent.click(await screen.findByRole("button", { name: "Skip this version" }));
  await waitFor(() => expect(calls).toEqual(["skip 1.1.0"]));
  expect(await screen.findByText(/Up to date/)).toBeTruthy();
  cleanup();
  fakeShell({ status: "error", error: "Couldn't check for updates: the release folder (E:\\Releases) isn't reachable." });
  render(<UpdateCard />);
  expect((await screen.findByRole("alert")).textContent).toMatch(/isn't reachable/);
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
});

it("the floating card stays out of the way unless there is something to install", async () => {
  fakeShell({ status: "up-to-date", checkedAt: 1 });
  const { container } = render(<UpdateCard compact />);
  await new Promise((r) => setTimeout(r, 10));
  expect(container.textContent).toBe("");
});
