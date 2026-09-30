// @vitest-environment node
// Route handlers run under Node: happy-dom's Request drops the Origin header these routes check.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

// The routes answer "not set up" unless the Fleet Health connector is configured.
beforeEach(() => {
  process.env.CHIEF_LEARNING_DIR = process.env.CHIEF_LEARNING_DIR || path.join(tmpdir(), "fleet-health-unset");
});
afterEach(() => {
  delete process.env.CHIEF_LEARNING_DIR;
});

it("every Fleet Health route says it is not set up when no ledger is configured", async () => {
  delete process.env.CHIEF_LEARNING_DIR;
  vi.resetModules();
  const { GET } = await import("@/app/api/fleet/health/route");
  const res = await GET(new Request("http://127.0.0.1:3000/api/fleet/health"));
  expect(res.status).toBe(404);
  expect((await res.json()).setup).toBe(true);
  const { POST } = await import("@/app/api/fleet/revert/route");
  const { NextRequest } = await import("next/server");
  const req = new NextRequest("http://127.0.0.1:3000/api/fleet/revert", { method: "POST", headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }, body: JSON.stringify({ id: 7 }) });
  expect((await POST(req)).status).toBe(404);
});

it("serves the report read-only and refuses a revert without the dashboard's origin or a real id", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-health-"));
  try {
    writeFileSync(path.join(dir, "report.json"), JSON.stringify({ generatedAt: Date.now() / 1000 - 60, desks: [] }));
    process.env.CHIEF_LEARNING_DIR = dir;
    vi.resetModules();
    const { GET } = await import("@/app/api/fleet/health/route");
    const body = await (await GET(new Request("http://127.0.0.1:3000/api/fleet/health"))).json();
    expect(body.ok).toBe(true);
    expect(body.ageSeconds).toBeGreaterThanOrEqual(59);

    const { POST } = await import("@/app/api/fleet/revert/route");
    const { NextRequest } = await import("next/server");
    const cross = new NextRequest("http://127.0.0.1:3000/api/fleet/revert", { method: "POST", headers: { origin: "https://evil.example", host: "127.0.0.1:3000" }, body: JSON.stringify({ id: 7 }) });
    expect((await POST(cross)).status).toBe(403);
    const bad = new NextRequest("http://127.0.0.1:3000/api/fleet/revert", { method: "POST", headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }, body: JSON.stringify({ id: "7; rm -rf" }) });
    expect((await POST(bad)).status).toBe(400);
  } finally {
    delete process.env.CHIEF_LEARNING_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

it("passes the later-edit count the viewer saw to the ledger, and rejects a bad count", async () => {
  const runLedger = vi.fn(async () => "reverted #7: ada/x is back");
  vi.resetModules();
  vi.doMock("@/lib/server/fleet", () => ({ runLedger }));
  try {
    const { POST } = await import("@/app/api/fleet/revert/route");
    const { NextRequest } = await import("next/server");
    const req = (body: unknown) => new NextRequest("http://127.0.0.1:3000/api/fleet/revert", { method: "POST", headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }, body: JSON.stringify(body) });
    expect((await POST(req({ id: 7, discardNewer: 2 }))).status).toBe(200);
    expect(runLedger).toHaveBeenLastCalledWith(["revert", "7", "--discard-newer", "2"]);
    expect((await POST(req({ id: 8 }))).status).toBe(200);
    expect(runLedger).toHaveBeenLastCalledWith(["revert", "8"]);
    expect((await POST(req({ id: 7, discardNewer: "all" }))).status).toBe(400);
  } finally {
    vi.doUnmock("@/lib/server/fleet");
  }
});

it("decisions are shared through decisions.json and show before the ledger runs again", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fleet-decide-"));
  try {
    writeFileSync(path.join(dir, "report.json"), JSON.stringify({
      generatedAt: Date.now() / 1000,
      proposals: [{ id: "20260927-1", status: "open" }, { id: "20260927-2", status: "applied", decision: "approve" }],
      flags: [{ id: "proposal:20260927-1", kind: "proposal", proposal: "20260927-1" }, { id: "churn:x", kind: "churn" }],
    }));
    process.env.CHIEF_LEARNING_DIR = dir;
    vi.resetModules();
    const { POST } = await import("@/app/api/fleet/decide/route");
    const { GET } = await import("@/app/api/fleet/health/route");
    const { NextRequest } = await import("next/server");
    const req = (body: unknown) => new NextRequest("http://127.0.0.1:3000/api/fleet/decide", { method: "POST", headers: { origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }, body: JSON.stringify(body) });
    expect((await POST(req({ id: "../../etc", decision: "approve" }))).status).toBe(400);
    expect((await POST(req({ id: "20260927-1", decision: "maybe" }))).status).toBe(400);
    expect((await POST(req({ id: "20260927-1", decision: "dismiss" }))).status).toBe(200);
    expect((await POST(req({ id: "20260927-2", decision: "approve" }))).status).toBe(200);
    const saved = JSON.parse(readFileSync(path.join(dir, "decisions.json"), "utf8"));
    expect(saved.items["20260927-1"].decision).toBe("dismiss");

    const body = await (await GET(new Request("http://127.0.0.1:3000/api/fleet/health"))).json();
    expect(body.proposals.map((p: { status: string }) => p.status)).toEqual(["dismissed", "applied"]); // the ledger's "applied" is kept
    expect(body.flags.map((f: { id: string }) => f.id)).toEqual(["churn:x"]); // a decided proposal is no longer waiting
    const flagsOnly = await (await GET(new Request("http://127.0.0.1:3000/api/fleet/health?only=flags"))).json();
    expect(Object.keys(flagsOnly).sort()).toEqual(["ageSeconds", "flags", "generatedAt", "ok"]);
  } finally {
    delete process.env.CHIEF_LEARNING_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});

it("serves a diff only for change numbers", async () => {
  const runLedger = vi.fn(async () => "@@ -1 +1 @@\n-a\n+b");
  vi.resetModules();
  vi.doMock("@/lib/server/fleet", () => ({ runLedger }));
  try {
    const { GET } = await import("@/app/api/fleet/diff/route");
    const { NextRequest } = await import("next/server");
    const get = (q: string) => GET(new NextRequest(`http://127.0.0.1:3000/api/fleet/diff?${q}`));
    expect((await get("id=9&from=4")).status).toBe(200);
    expect(runLedger).toHaveBeenLastCalledWith(["diff", "9", "--from", "4"], 20_000);
    expect((await get("id=9")).status).toBe(200);
    expect(runLedger).toHaveBeenLastCalledWith(["diff", "9"], 20_000);
    expect((await get("id=9;rm")).status).toBe(400);
    expect((await get("id=4&from=9")).status).toBe(400);
  } finally {
    vi.doUnmock("@/lib/server/fleet");
  }
});
