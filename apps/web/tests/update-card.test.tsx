import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { UpdateCard } from "@/components/updates/update-card";
import type { UpdateOptions, UpdateState } from "@/lib/desktop";

const release = { version: "1.1.0", published: "", notes: "Faster startup.", package: { file: "x.msix", bytes: 150_000_000, sha256: "a".repeat(64) }, hermes: { base_version: "2026.10.1", commit: "c" } };

function fakeShell(
  initial: UpdateState,
  script: Partial<Record<"prepare" | "restart" | "skip" | "check", (arg?: unknown) => UpdateState>> = {},
  options: UpdateOptions = { prepare: true, early: false },
) {
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
    prepare: async () => (calls.push("prepare"), set(script.prepare?.() ?? state)),
    restart: async (force?: boolean) => (calls.push(`restart${force ? " now" : ""}`), set(script.restart?.(force) ?? state)),
    skip: async (v: string) => (calls.push(`skip ${v}`), set(script.skip?.(v) ?? state)),
    feed: async () => "E:\\Releases",
    setFeed: async () => state,
    options: async () => options,
    setOptions: async (patch: Partial<UpdateOptions>) => (calls.push(`options ${JSON.stringify(patch)}`), state),
    onState: (fn: (s: UpdateState) => void) => (listeners.add(fn), () => listeners.delete(fn)),
    emit: set,
  };
  (window as unknown as { chiefDesktop: unknown }).chiefDesktop = { updates: api };
  // `emit` pushes a state from the shell; non-enumerable so `calls` still compares as a plain list.
  return Object.defineProperty(calls, "emit", { value: set }) as string[] & { emit: (s: UpdateState) => UpdateState };
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { chiefDesktop?: unknown }).chiefDesktop;
});

it("shows nothing outside the desktop app", () => {
  const { container } = render(<UpdateCard />);
  expect(container.textContent).toBe("");
});

it("offers the update with versions and size; Get update prepares it while Chief keeps working", async () => {
  const calls = fakeShell({ status: "available", checkedAt: 1, release }, { prepare: () => ({ status: "preparing", release, step: "stage", pct: 62 }) });
  render(<UpdateCard />);
  expect(await screen.findByText("Update available")).toBeTruthy();
  expect(screen.getByText(/Version 1\.1\.0 · Hermes 2026\.10\.1 · 150 MB\. It gets ready while .* keeps working; you choose when to restart\./)).toBeTruthy();
  expect(screen.getByText("Faster startup.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Get update" }));
  await waitFor(() => expect(calls).toEqual(["prepare"]));
  expect(await screen.findByText("Getting 1.1.0 ready…")).toBeTruthy();
  const bar = screen.getByRole("progressbar");
  expect(bar.getAttribute("aria-valuenow")).toBe("62");
  expect(screen.getByText("62%")).toBeTruthy();
});

it("a backup of unknown length shows a sweep, not a made-up percentage", async () => {
  fakeShell({ status: "preparing", release, step: "backup", pct: null });
  render(<UpdateCard />);
  expect(await screen.findByText("Backing up before 1.1.0…")).toBeTruthy();
  expect(screen.getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
  expect(screen.queryByText(/%$/)).toBeNull();
});

it("once ready, Restart to update restarts; the time it takes depends on whether Windows unpacked it already", async () => {
  const calls = fakeShell({ status: "ready", release, file: "x.msix", staged: true }, { restart: () => ({ status: "restarting", release, step: "Closing Chief…" }) });
  render(<UpdateCard />);
  expect(await screen.findByText("Version 1.1.0 is ready")).toBeTruthy();
  expect(screen.getByText(/about twenty seconds/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Restart to update" }));
  await waitFor(() => expect(calls).toEqual(["restart"]));
  expect(await screen.findByText("Closing Chief…")).toBeTruthy();
  cleanup();
  fakeShell({ status: "ready", release, file: "x.msix", staged: false });
  render(<UpdateCard />);
  expect(await screen.findByText(/about a minute/)).toBeTruthy();
});

it("while Chief is busy it offers to wait, restart now, or later", async () => {
  const onLater = vi.fn();
  const calls = fakeShell(
    { status: "busy", release, file: "x.msix", staged: true, reasons: ["Nova is writing a reply."] },
    { restart: (force) => (force ? { status: "restarting", release, step: "Closing Chief…" } : { status: "busy", release, file: "x.msix", staged: true, reasons: ["Nova is writing a reply."] }) },
  );
  render(<UpdateCard onLater={onLater} />);
  expect(await screen.findByText(/Nova is writing a reply\. Restarting stops/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Later" }));
  expect(onLater).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
  await waitFor(() => expect(calls).toContain("restart now"));
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

it("an update that didn't finish is said plainly, and Try again prepares it again", async () => {
  const calls = fakeShell({ status: "error", error: "The update to 1.1.0 didn't finish: files in use. You're still on 1.0.0; nothing was changed.", release });
  render(<UpdateCard compact onLater={() => undefined} />);
  expect((await screen.findByRole("alert")).textContent).toMatch(/didn't finish/);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(calls).toEqual(["prepare"]));
});

it("the floating card stays quiet while an update prepares in the background, and speaks up once it's ready", async () => {
  const shell = fakeShell({ status: "preparing", release, step: "stage", pct: 30 });
  const { container } = render(<UpdateCard compact />);
  await new Promise((r) => setTimeout(r, 10));
  expect(container.textContent).toBe("");
  shell.emit({ status: "ready", release, file: "x.msix", staged: true });
  expect(await screen.findByRole("region", { name: "App update" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Restart to update" })).toBeTruthy();
});

it("with the background prepare off, the floating card offers the update itself", async () => {
  fakeShell({ status: "available", checkedAt: 1, release }, {}, { prepare: false, early: false });
  render(<UpdateCard compact />);
  expect(await screen.findByRole("button", { name: "Get update" })).toBeTruthy();
});

it("the floating card stays out of the way when there's nothing to do", async () => {
  fakeShell({ status: "up-to-date", checkedAt: 1 });
  const { container } = render(<UpdateCard compact />);
  await new Promise((r) => setTimeout(r, 10));
  expect(container.textContent).toBe("");
});

it("Settings offers the background prepare and early updates as switches", async () => {
  const calls = fakeShell({ status: "up-to-date", checkedAt: 1 }, {}, { prepare: true, early: false });
  const { UpdatesPanel } = await import("@/components/updates/update-card");
  render(<UpdatesPanel />);
  const early = await screen.findByRole("switch", { name: "Early updates" });
  expect(early.getAttribute("aria-checked")).toBe("false");
  expect(screen.getByRole("switch", { name: "Get updates ready in the background" }).getAttribute("aria-checked")).toBe("true");
  fireEvent.click(early);
  await waitFor(() => expect(calls).toContain('options {"early":true}'));
  expect(screen.getByRole("switch", { name: "Early updates" }).getAttribute("aria-checked")).toBe("true");
});

it("a private GitHub release source asks for its key once, and keeps it sealed in the shell", async () => {
  const saved: string[] = [];
  let hasKey = false;
  (window as unknown as { chiefDesktop: unknown }).chiefDesktop = {
    updates: {
      state: async () => ({ status: "idle" }),
      check: async () => ({ status: "idle" }),
      prepare: async () => ({ status: "idle" }),
      restart: async () => ({ status: "idle" }),
      skip: async () => ({ status: "idle" }),
      feed: async () => "github:me/chief-releases",
      setFeed: async () => ({ status: "idle" }),
      hasKey: async () => hasKey,
      setKey: async (k: string) => (saved.push(k), (hasKey = true), { status: "idle" }),
      onState: () => () => undefined,
    },
  };
  const { UpdatesPanel, isGithubFeed } = await import("@/components/updates/update-card");
  expect(isGithubFeed("https://github.com/me/r")).toBe(true);
  expect(isGithubFeed("E:\Releases")).toBe(false);
  render(<UpdatesPanel />);
  const field = (await screen.findByLabelText(/^Update key/)) as HTMLInputElement;
  expect(field.type).toBe("password");
  fireEvent.change(field, { target: { value: " github_pat_abc " } });
  fireEvent.click(screen.getByRole("button", { name: "Save key" }));
  await waitFor(() => expect(saved).toEqual(["github_pat_abc"]));
  expect(field.value).toBe(""); // never kept in the page
  expect(await screen.findByText(/Saved and protected by Windows/)).toBeTruthy();
});

it("the floating card has its own surface while it restarts, never bare text over the page", async () => {
  fakeShell({ status: "restarting", release: release as never, step: "Closing Chief…" });
  render(<UpdateCard compact />);
  const card = await screen.findByRole("region", { name: "App update" });
  expect(card.className).toMatch(/bg-raised/);
  expect(card.textContent).toMatch(/Closing Chief….* will be back in a moment\./);
});
