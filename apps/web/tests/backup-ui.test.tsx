import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { BackupPanel } from "@/components/backup/backup-panel";
import { RestoreFlow } from "@/components/backup/restore-flow";

type Handler = (body: Record<string, unknown>) => unknown;

function route(handlers: Record<string, Handler>) {
  const calls: { path: string; method: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const p = new URL(String(input), "http://127.0.0.1:3100").pathname.replace("/api/backup/", "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ path: p, method: init?.method || "GET", body });
      const handler = handlers[p];
      return Response.json(handler ? handler(body) : { ok: false, error: `no handler for ${p}` });
    }),
  );
  return calls;
}

const STATUS = {
  ok: true,
  settings: { folder: "", schedule: "weekly", keep: 4, parts: "everything" },
  suggestedFolder: "C:\\Users\\me\\Documents\\Chief Backups",
  lastBackup: null,
  lastError: null,
  remind: false,
  job: null,
  available: { setup: true, secondBrain: true },
  secondBrain: "C:\\Users\\me\\Documents\\Second Brain",
  appVersion: "1.0.0",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as unknown as { chiefDesktop?: unknown }).chiefDesktop;
});

it("shows the suggested folder without applying it, and backs up only after a folder is saved", async () => {
  let status: Record<string, unknown> = STATUS;
  const calls = route({
    status: () => status,
    list: () => ({ ok: true, backups: [] }),
    settings: (b) => {
      status = { ...STATUS, settings: { ...STATUS.settings, ...b } };
      return { ok: true, settings: (status as typeof STATUS).settings };
    },
    run: () => ({ ok: true, job: { kind: "manual", state: "running", startedAt: 1, done: 0, total: 10 } }),
  });
  render(<BackupPanel />);
  expect(await screen.findByText("Choose where backups go to start backing up.")).toBeTruthy();
  const input = screen.getByPlaceholderText(STATUS.suggestedFolder) as HTMLInputElement;
  expect(input.value).toBe("");
  expect((screen.getByRole("button", { name: "Back up now" }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.some((c) => c.path === "settings")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: /^Use .*Chief Backups$/ }));
  expect(input.value).toBe(STATUS.suggestedFolder);
  fireEvent.click(screen.getByRole("button", { name: "Save folder" }));
  await waitFor(() => expect(calls.find((c) => c.path === "settings")?.body).toEqual({ folder: STATUS.suggestedFolder }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Back up now" }) as HTMLButtonElement).disabled).toBe(false));

  fireEvent.click(screen.getByRole("checkbox", { name: /Encrypt with a passphrase/ }));
  fireEvent.change(screen.getByPlaceholderText("Passphrase"), { target: { value: "long passphrase" } });
  fireEvent.change(screen.getByPlaceholderText("Again"), { target: { value: "different one" } });
  fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
  expect(await screen.findByText("The passphrases don't match.")).toBeTruthy();
  fireEvent.change(screen.getByPlaceholderText("Again"), { target: { value: "long passphrase" } });
  status = { ...status, job: { kind: "manual", state: "running", startedAt: 1, done: 5, total: 10 } };
  fireEvent.click(screen.getByRole("button", { name: "Back up now" }));
  await waitFor(() => expect(calls.find((c) => c.path === "run")?.body).toEqual({ parts: "everything", passphrase: "long passphrase" }));
  expect(await screen.findByRole("progressbar", { name: "Backup progress" })).toBeTruthy();
});

it("reminds after a month without a backup and reports a failed automatic one", async () => {
  route({
    status: () => ({
      ...STATUS,
      settings: { ...STATUS.settings, folder: "D:\\Backups" },
      lastBackup: { at: Date.now() - 40 * 86_400_000, path: "D:\\Backups\\x.chiefbackup", kind: "auto", bytes: 12_000_000, encrypted: false },
      lastError: { at: Date.now(), error: "There isn't enough free space for the backup.", kind: "auto" },
      remind: true,
    }),
    list: () => ({ ok: true, backups: [{ name: "Chief backup (auto) 2026-08-20 100000.chiefbackup", path: "D:\\Backups\\a.chiefbackup", bytes: 12_000_000, mtime: 1, auto: true, encrypted: false }] }),
  });
  render(<BackupPanel />);
  expect(await screen.findByText(/Last backup: 40 days ago \(12 MB\)\. It's been a while/)).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toMatch(/last automatic backup failed: There isn't enough free space/);
  expect(await screen.findByText("Chief backup (auto) 2026-08-20 100000")).toBeTruthy();
});

it("restores: passphrase, preview, choose parts, verified staging, then the desktop app applies it", async () => {
  const calls = route({
    inspect: (b) =>
      !b.passphrase
        ? { ok: true, encrypted: true, needs_passphrase: true }
        : b.passphrase === "right passphrase"
          ? {
              ok: true, encrypted: true, needs_passphrase: false, compatible: true, created: "2026-09-30T10:00:00+0000", app_version: "1.0.0",
              hermes_version: "2026.9.24", parts: ["setup", "second-brain"], secrets_included: true, dropped_secrets: [],
              summary: { profiles: ["chief", "helper"], notes: 1240, bytes: 52_000_000 }, source: { second_brain: "D:\\Old\\Second Brain" },
            }
          : { ok: false, code: "passphrase", error: "That passphrase doesn't open this backup." },
    "restore/stage": () => ({ ok: true, parts: ["setup"], files: 10 }),
  });
  const applyRestore = vi.fn(async () => ({ ok: true, report: { remapped: [], review: [{ file: "profiles/chief/config.yaml", line: 4, text: "cwd: D:\\Old\\work" }], missing_secrets: [] } }));
  (window as unknown as { chiefDesktop: unknown }).chiefDesktop = { applyRestore };
  render(<RestoreFlow initialFile={"D:\\Backups\\b.chiefbackup"} secondBrain={"C:\\Notes"} />);
  fireEvent.click(screen.getByRole("button", { name: "Open backup" }));
  expect(await screen.findByRole("heading", { name: "This backup is encrypted" })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "nope" } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
  expect(await screen.findByText("That passphrase doesn't open this backup.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "right passphrase" } });
  fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
  expect(await screen.findByRole("heading", { name: "What's in this backup" })).toBeTruthy();
  expect(screen.getByText("chief, helper")).toBeTruthy();
  expect(screen.getByText("1,240")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /Second Brain/ }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("heading", { name: "Ready to restore" })).toBeTruthy();
  expect(calls.find((c) => c.path === "restore/stage")?.body).toEqual({ file: "D:\\Backups\\b.chiefbackup", parts: ["setup"], passphrase: "right passphrase", secondBrain: "" });
  fireEvent.click(screen.getByRole("button", { name: "Restore now" }));
  expect(await screen.findByRole("heading", { name: "Restored" })).toBeTruthy();
  expect(applyRestore).toHaveBeenCalledOnce();
  expect(screen.getByText(/profiles\/chief\/config\.yaml:4/)).toBeTruthy();
});

it("a backup from a newer app can't be restored, and a browser without the desktop app can't apply", async () => {
  route({
    inspect: () => ({ ok: true, encrypted: false, needs_passphrase: false, compatible: false, problem: "This backup was made by a newer version of the app (2.0.0). Update the app first.", parts: ["setup"], summary: {} }),
  });
  render(<RestoreFlow initialFile="D:\\new.chiefbackup" />);
  fireEvent.click(screen.getByRole("button", { name: "Open backup" }));
  expect(await screen.findByText(/Update the app first/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Continue" })).toBeNull();
  cleanup();
  route({
    inspect: () => ({ ok: true, encrypted: false, needs_passphrase: false, compatible: true, parts: ["setup"], secrets_included: false, dropped_secrets: ["OPENROUTER_API_KEY"], summary: {} }),
    "restore/stage": () => ({ ok: true }),
  });
  render(<RestoreFlow initialFile="D:\\old.chiefbackup" />);
  fireEvent.click(screen.getByRole("button", { name: "Open backup" }));
  expect(await screen.findByText(/wasn't encrypted, so API keys and sign-ins aren't in it/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByText(/Finish in the desktop app/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Restore now" })).toBeNull();
});
