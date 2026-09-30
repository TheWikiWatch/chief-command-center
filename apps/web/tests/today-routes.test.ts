// @vitest-environment node
// Route handlers run under Node: happy-dom's Request drops the Origin header these routes check.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, expect, it, vi } from "vitest";

import { isoDay } from "@/lib/server/today-index";

const vault = mkdtempSync(path.join(tmpdir(), "chief-today-route-"));
mkdirSync(path.join(vault, "10 Projects"), { recursive: true });
writeFileSync(path.join(vault, "10 Projects", "Garden.md"), `- [ ] Buy seeds 📅 ${isoDay(new Date(Date.now() - 2 * 86_400_000))}\n- [ ] Dig beds #waiting\n`);
afterAll(() => rmSync(vault, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.CHIEF_VAULT_PATH;
  delete process.env.CHIEF_OPS_URL;
  vi.unstubAllGlobals();
});

async function ops(method: string, route: string, body?: unknown) {
  vi.resetModules();
  const mod = await import("@/app/api/ops/[...path]/route");
  const { NextRequest } = await import("next/server");
  const url = `http://127.0.0.1:3100/api/ops/${route}`;
  const req = new NextRequest(url, {
    method,
    headers: { origin: "http://127.0.0.1:3100", host: "127.0.0.1:3100", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const handler = (mod as unknown as Record<string, (r: Request, c: { params: Promise<{ path: string[] }> }) => Promise<Response>>)[method];
  return handler(req, { params: Promise.resolve({ path: route.split("?")[0].split("/") }) });
}

it("says Today needs a Second Brain when neither a folder nor a task service is set", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: true, configured: false, path: "" })));
  const res = await ops("GET", "today");
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ setup: true });
});

it("answers Today from the Second Brain without a task service", async () => {
  process.env.CHIEF_VAULT_PATH = vault;
  const meta = await (await ops("GET", "meta")).json();
  expect(meta).toMatchObject({ vault_exists: true, open_total: 2, overdue_total: 1, source: "vault" });
  const today = await (await ops("GET", "today")).json();
  expect(today.items.map((i: { text: string; when_label: string }) => [i.text, i.when_label])).toEqual([["Buy seeds", "2d overdue"]]);
  const boards = await (await ops("GET", "boards?include_done=false")).json();
  expect(boards.boards[0]).toMatchObject({ board_name: "Garden", waiting_count: 1 });
  const attention = await (await ops("GET", "attention")).json();
  expect([attention.overdue.length, attention.waiting.length]).toEqual([1, 1]);

  const card = today.items[0].card;
  const launch = await (await ops("POST", "launch", { intent: "task.complete", board_name: "Garden", card_id: card.id, mode: "chief_inject" })).json();
  expect(launch.ok).toBe(true);
  expect(launch.kickoff).toContain('"Buy seeds" (`10 Projects/Garden.md`, line 1)');

  const put = await ops("PUT", "settings", { vault_path: "D:\Elsewhere" });
  expect(put.status).toBe(400);
  expect((await (await ops("GET", "settings")).json()).vault_path).toBe(vault);
});

it("reads the folder Chief was set up with when no path is configured here", async () => {
  const fetcher = vi.fn(async () => Response.json({ ok: true, configured: true, path: vault }));
  vi.stubGlobal("fetch", fetcher);
  const meta = await (await ops("GET", "meta")).json();
  expect(meta.vault_path).toBe(path.resolve(vault));
  expect(String((fetcher.mock.calls[0] as unknown[])[0])).toMatch(/\/setup\/second-brain$/);
});
