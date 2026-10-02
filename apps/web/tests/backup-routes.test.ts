// @vitest-environment node
// Runs the real backup engine (backup/chief_backup) through the routes, on a synthetic home.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, expect, it, vi } from "vitest";

const tmp = mkdtempSync(path.join(tmpdir(), "chief-backup-route-"));
const home = path.join(tmp, "hermes");
const vault = path.join(tmp, "Second Brain");
const appData = path.join(tmp, "app-data");
const dest = path.join(tmp, "Backups");

beforeAll(() => {
  mkdirSync(path.join(home, "profiles", "chief", "memories"), { recursive: true });
  writeFileSync(path.join(home, "profiles", "chief", "SOUL.md"), "You are Chief.\n");
  writeFileSync(path.join(home, "profiles", "chief", ".env"), "OPENROUTER_API_KEY=sk-synthetic\nCHIEF_DASHBOARD_PORT=7790\n");
  mkdirSync(path.join(vault, "00 Inbox"), { recursive: true });
  writeFileSync(path.join(vault, "00 Inbox", "Idea.md"), "- [ ] try\n");
  Object.assign(process.env, {
    CHIEF_APP_DATA: appData,
    CHIEF_HERMES_ROOT: home,
    CHIEF_VAULT_PATH: vault,
    CHIEF_PYTHON: process.env.CHIEF_TEST_PYTHON || "python",
    CHIEF_BACKUP_ENGINE: path.resolve(__dirname, "..", "..", "..", "backup"),
    CHIEF_APP_VERSION: "1.0.0",
  });
});
afterAll(() => {
  for (const key of ["CHIEF_APP_DATA", "CHIEF_HERMES_ROOT", "CHIEF_VAULT_PATH", "CHIEF_PYTHON", "CHIEF_BACKUP_ENGINE", "CHIEF_APP_VERSION"]) delete process.env[key];
  rmSync(tmp, { recursive: true, force: true });
});

async function call(method: string, op: string, body?: unknown, origin = "http://127.0.0.1:3100", extra: Record<string, string> = {}) {
  const mod = await import("@/app/api/backup/[...op]/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest(`http://127.0.0.1:3100/api/backup/${op}`, {
    method,
    headers: { origin, host: "127.0.0.1:3100", "content-type": "application/json", ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const handler = (mod as unknown as Record<string, (r: Request, c: { params: Promise<{ op: string[] }> }) => Promise<Response>>)[method];
  const res = await handler(req, { params: Promise.resolve({ op: op.split("/") }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function waitForJob() {
  const { currentJob } = await import("@/lib/server/backup");
  for (let i = 0; i < 300; i++) {
    const job = currentJob();
    if (job && job.state !== "running") return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("backup never finished");
}

it("does nothing until a folder is chosen, then backs up, lists, inspects and schedules", { timeout: 120_000 }, async () => {
  const first = await call("GET", "status");
  expect(first.body).toMatchObject({ ok: true, lastBackup: null, remind: false, available: { setup: true, secondBrain: true } });
  expect((first.body.settings as { folder: string; schedule: string; keep: number }).folder).toBe("");
  expect(String(first.body.suggestedFolder)).toMatch(/Chief Backups$/);

  const { scheduledTick } = await import("@/lib/server/backup");
  expect(await scheduledTick()).toBe("no-folder"); // weekly is preselected but never runs without a folder

  expect((await call("PUT", "settings", { folder: "relative\\path" })).status).toBe(400);
  expect((await call("PUT", "settings", { folder: dest }, "http://evil.example")).status).toBe(403);
  expect((await call("POST", "run", {})).body).toMatchObject({ ok: false, error: "Choose a backup folder first." });
  expect((await call("PUT", "settings", { folder: dest, keep: 3 })).body).toMatchObject({ ok: true, settings: { folder: dest, keep: 3, schedule: "weekly" } });

  const started = await call("POST", "run", { parts: "everything" });
  expect(started.body).toMatchObject({ ok: true, job: { state: "running", kind: "manual" } });
  const job = await waitForJob();
  expect(job.state).toBe("done");
  expect(job.result?.dropped_secrets).toContain("OPENROUTER_API_KEY");
  expect(existsSync(job.result!.path)).toBe(true);

  const status = await call("GET", "status");
  expect(status.body.lastBackup).toMatchObject({ kind: "manual", encrypted: false });
  expect(await scheduledTick()).toBe("not-due");

  const listed = await call("GET", "list");
  expect((listed.body.backups as unknown[]).length).toBe(1);

  const info = await call("POST", "inspect", { file: job.result!.path });
  expect(info.body).toMatchObject({ ok: true, compatible: true, parts: ["setup", "second-brain"], secrets_included: false });

  // An encrypted manual backup; the passphrase never lands in settings.
  await new Promise((r) => setTimeout(r, 1100));
  await call("POST", "run", { parts: "setup", passphrase: "long enough passphrase" });
  const secret = await waitForJob();
  expect(secret.result?.encrypted).toBe(true);
  expect(readFileSync(path.join(appData, "settings.json"), "utf8")).not.toContain("long enough passphrase");
  expect((await call("POST", "inspect", { file: secret.result!.path })).body).toMatchObject({ ok: true, needs_passphrase: true });
  expect((await call("POST", "inspect", { file: secret.result!.path, passphrase: "wrong one" })).body).toMatchObject({ ok: false, code: "passphrase" });

  // A week later the schedule runs an automatic backup.
  expect(await scheduledTick(Date.now() + 8 * 24 * 3600 * 1000)).toBe("ran");
  const auto = await waitForJob();
  expect(auto.kind).toBe("auto");
  expect(path.basename(auto.result!.path)).toMatch(/^Chief backup \(auto\) /);

  await call("PUT", "settings", { schedule: "off" });
  expect(await scheduledTick(Date.now() + 30 * 24 * 3600 * 1000)).toBe("off");
});

it("stages a restore of the Second Brain into a new folder, verified, without touching anything live", { timeout: 120_000 }, async () => {
  const { currentJob } = await import("@/lib/server/backup");
  const file = currentJob()!.result!.path;
  const target = path.join(tmp, "Restored Brain");
  const staged = await call("POST", "restore/stage", { file, parts: ["second-brain"], secondBrain: target });
  expect(staged.body).toMatchObject({ ok: true, parts: ["second-brain"] });
  expect(existsSync(target)).toBe(false); // only the desktop app applies a restore
  expect(existsSync(path.join(appData, "restore", "restore-journal.json"))).toBe(true);
  expect((await call("POST", "restore/discard", {})).body).toMatchObject({ ok: true, action: "discarded-staging" });
  expect(existsSync(path.join(appData, "restore", "restore-journal.json"))).toBe(false);
  vi.resetModules();
});

it("a phone can see backups and change the schedule, but not choose folders or files on the PC", async () => {
  // What Tailscale Serve adds to a request from the phone.
  const phone = { "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.9", "tailscale-user-login": "me@example.com" };
  const folder = await call("PUT", "settings", { folder: path.join(tmp, "elsewhere") }, "http://127.0.0.1:3100", phone);
  expect(folder.status).toBe(403);
  const schedule = await call("PUT", "settings", { schedule: "off" }, "http://127.0.0.1:3100", phone);
  expect(schedule.status).toBe(200);
  for (const op of ["inspect", "restore/stage", "restore/discard", "restore/finish"]) {
    expect((await call("POST", op, { file: "C:/anything.chiefbackup" }, "http://127.0.0.1:3100", phone)).status, op).toBe(403);
  }
});
