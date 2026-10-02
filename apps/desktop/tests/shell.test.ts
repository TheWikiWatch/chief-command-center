import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { activeWork, fromBridgeSnapshot } from "../src/active-work";
import { curatedEnv, leakedKeys, payloadLayout } from "../src/env";
import { gatewayOwner } from "../src/gateway";
import { Notifier, snippet } from "../src/notifier";
import { isFree, pickPort } from "../src/ports";
import { applyRestore } from "../src/restore";
import { bridgeToken } from "../src/secrets";
import { Store } from "../src/store";
import { BACKOFF_MS, MAX_RESTARTS, Supervisor, type SupervisorEvent } from "../src/supervisor";

const tmp = mkdtempSync(path.join(tmpdir(), "chief-desktop-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/* ------------------------------------------------------------------ supervisor */

function harness(opts: { failLaunch?: boolean; failReady?: boolean } = {}) {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  const events: SupervisorEvent[] = [];
  let pid = 100;
  const stops: boolean[] = [];
  const sup = new Supervisor({
    launch: async () => {
      if (opts.failLaunch) throw new Error("no launcher");
      const mine = ++pid;
      return { pid: mine, stop: async (graceful: boolean) => void stops.push(graceful) };
    },
    ready: async () => {
      if (opts.failReady) throw new Error("never ready");
    },
    now: () => now,
    setTimer: (fn, ms) => timers.push({ at: now + ms, fn }),
    clearTimer: () => timers.splice(0),
    onEvent: (e) => events.push(e),
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const t of timers.splice(0).filter((x) => x.at <= now)) t.fn();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { sup, events, stops, advance, timers, setNow: (n: number) => (now = n), getNow: () => now };
}

describe("Supervisor", () => {
  it("starts, restarts after crashes with 1 s / 5 s / 30 s backoff, and ignores stale exits", async () => {
    const h = harness();
    await h.sup.start();
    expect(h.sup.state).toBe("running");
    const first = h.sup.child!.pid;
    h.sup.exited(1, 9999); // not our child
    expect(h.sup.state).toBe("running");
    h.sup.exited(1, first);
    expect(h.sup.state).toBe("backoff");
    expect(h.events.filter((e) => e.type === "restart-scheduled").map((e) => (e as { inMs: number }).inMs)).toEqual([BACKOFF_MS[0]]);
    await h.advance(1000);
    expect(h.sup.state).toBe("running");
    h.sup.exited(1, h.sup.child!.pid);
    await h.advance(5000);
    h.sup.exited(1, h.sup.child!.pid);
    await h.advance(30_000);
    h.sup.exited(1, h.sup.child!.pid);
    expect(h.events.filter((e) => e.type === "restart-scheduled").map((e) => (e as { inMs: number }).inMs)).toEqual([1000, 5000, 30_000, 30_000]);
  });

  it(`gives up after ${MAX_RESTARTS} restarts in 10 minutes, and Retry starts over`, async () => {
    const h = harness();
    await h.sup.start();
    for (let i = 0; i < MAX_RESTARTS; i++) {
      h.sup.exited(1, h.sup.child!.pid);
      await h.advance(30_000);
    }
    h.sup.exited(1, h.sup.child!.pid);
    expect(h.sup.state).toBe("failed");
    await h.sup.start();
    expect(h.sup.state).toBe("running");
  });

  it("an old crash leaves the 10-minute window", async () => {
    const h = harness();
    await h.sup.start();
    for (let i = 0; i < MAX_RESTARTS; i++) {
      h.sup.exited(1, h.sup.child!.pid);
      await h.advance(30_000);
    }
    await h.advance(11 * 60_000);
    h.sup.exited(1, h.sup.child!.pid);
    expect(h.sup.state).toBe("backoff");
  });

  it("an exit it asked for is never restarted, and stop is graceful", async () => {
    const h = harness();
    await h.sup.start();
    const pid = h.sup.child!.pid;
    await h.sup.stop(true);
    h.sup.exited(0, pid);
    expect(h.sup.state).toBe("stopped");
    expect(h.stops).toEqual([true]);
    expect(h.timers).toHaveLength(0);
  });

  it("a launch or readiness failure counts as a crash", async () => {
    const launch = harness({ failLaunch: true });
    await launch.sup.start();
    expect(launch.sup.state).toBe("backoff");
    expect(launch.sup.detail).toBe("no launcher");
    const ready = harness({ failReady: true });
    await ready.sup.start();
    expect(ready.sup.state).toBe("backoff");
    expect(ready.stops).toEqual([false]); // the half-started child is ended
  });
});

/* ------------------------------------------------------------------ environment */

describe("curatedEnv", () => {
  const payload = payloadLayout("C:\\App\\payload", ["git\\cmd", "ffmpeg\\bin"]);
  const ambient = {
    SystemRoot: "C:\\Windows",
    USERPROFILE: "D:\\Home\\someone",
    LOCALAPPDATA: "D:\\Home\\someone\\AppData\\Local",
    TEMP: "C:\\Temp",
    PATH: "D:\\Home\\someone\\bin;C:\\Program Files\\GitHub CLI",
    HERMES_HOME: "C:\\old\\hermes",
    OPENAI_API_KEY: "sk-ambient",
    GH_TOKEN: "ghp-ambient",
    GITHUB_TOKEN: "ambient",
    ANTHROPIC_API_KEY: "ambient",
    NODE_OPTIONS: "--require evil.js",
    HTTPS_PROXY: "http://proxy:8080",
  };

  it("passes Windows basics and proxies, drops ambient credentials and Hermes settings, and sets its own", () => {
    const env = curatedEnv(ambient, { payload, set: { HERMES_HOME: "C:\\App\\data\\hermes", CHIEF_DASHBOARD_TOKEN: "app-token" } });
    expect(env.HERMES_HOME).toBe("C:\\App\\data\\hermes");
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.HTTPS_PROXY).toBe("http://proxy:8080");
    for (const k of ["OPENAI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "ANTHROPIC_API_KEY", "NODE_OPTIONS"]) expect(env[k]).toBeUndefined();
    expect(leakedKeys(env)).toEqual(["HERMES_HOME", "CHIEF_DASHBOARD_TOKEN"]); // only what the app set itself
    const pathParts = env.PATH.split(";");
    expect(pathParts[0]).toBe("C:\\App\\payload\\bin");
    expect(pathParts).toContain("C:\\App\\payload\\tools\\git\\cmd");
    expect(pathParts).toContain("C:\\Windows\\System32");
    expect(env.PATH).not.toContain("GitHub CLI");
  });

  it("an adopted install may keep the user's PATH", () => {
    const env = curatedEnv(ambient, { payload, set: {}, inheritUserPath: true });
    expect(env.PATH).toContain("GitHub CLI");
    expect(env.GH_TOKEN).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ ports */

describe("ports", () => {
  it("keeps a free preferred port, skips taken and avoided ones", async () => {
    const taken = new Set([3000, 3001]);
    expect(await pickPort(3000, [3002], async (p) => !taken.has(p))).toBe(3003);
    expect(await pickPort(7790, [], async () => true)).toBe(7790);
    await expect(pickPort(4000, [], async () => false, 3)).rejects.toThrow(/No free port/);
  });

  it("sees a real listener", async () => {
    const server = net.createServer().listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as net.AddressInfo).port;
    expect(await isFree(port)).toBe(false);
    await new Promise((r) => server.close(r));
    expect(await isFree(port)).toBe(true);
  });
});

/* ------------------------------------------------------------------ quitting */

describe("activeWork", () => {
  it("names each reason to wait, from the bridge snapshot", () => {
    const snap = fromBridgeSnapshot({ generating: true, approval: { requestId: "a1" }, roster: [{ name: "Chief", ring: "idle" }, { name: "Scout", ring: "working" }] });
    expect(activeWork(snap, "Nova")).toEqual({
      busy: true,
      reasons: ["Nova is writing a reply.", "Nova is waiting for your approval.", "Scout is working on a task."],
    });
    expect(activeWork(fromBridgeSnapshot({ generating: false, roster: [] }))).toEqual({ busy: false, reasons: [] });
    expect(activeWork(null).busy).toBe(false);
  });
});

/* ------------------------------------------------------------------ notifications */

describe("Notifier", () => {
  function fakeBridge(pages: unknown[]) {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(pages.shift() ?? { messages: [] }));
    });
    return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
  }

  it("starts from the newest message, then notifies only new replies and approvals while hidden", async () => {
    const bridge = fakeBridge([
      { messages: [{ id: 5, role: "assistant", content: "old reply" }], approval: null },
      { messages: [{ id: 6, role: "user", content: "hi" }, { id: 7, role: "assistant", content: "Here is the plan.\nStep one." }], approval: null },
      { messages: [], approval: { requestId: "r9", description: "Run the backup script" } },
      { messages: [{ id: 8, role: "assistant", content: "Done." }], approval: null },
    ]);
    const shown: [string, string][] = [];
    let hidden = true;
    const n = new Notifier({ port: () => 7790, token: "t", assistant: () => "Chief", shouldNotify: () => hidden, notify: (a, b) => shown.push([a, b]), fetchImpl: bridge.fetchImpl });
    await n.step();
    expect(shown).toEqual([]); // history is never announced
    await n.step();
    expect(bridge.calls[1]).toContain("after=5&wait=25");
    expect(shown).toEqual([["Chief", "Here is the plan. Step one."]]);
    await n.step();
    expect(shown[1]).toEqual(["Chief needs your approval", "Run the backup script"]);
    hidden = false;
    await n.step();
    expect(shown).toHaveLength(2); // the window is in front: no notification
    expect(bridge.calls[3]).toContain("after=7");
  });

  it("keeps notifications short", () => {
    expect(snippet("x".repeat(300)).length).toBe(140);
    expect(snippet("  a \n b ")).toBe("a b");
  });
});

/* ------------------------------------------------------------------ restore orchestration */

describe("applyRestore", () => {
  function deps(over: Partial<Parameters<typeof applyRestore>[0]> = {}) {
    const log: string[] = [];
    const base: Parameters<typeof applyRestore>[0] = {
      engine: async (args) => {
        log.push(`engine ${args[0]}`);
        return args[0] === "apply" ? { ok: true, remapped: ["x"], review: [], missing_secrets: ["KEY"] } : { ok: true };
      },
      stateDir: "s",
      safetyDir: "f",
      appVersion: "1.0.0",
      stopGateway: async () => void log.push("stop"),
      startGateway: async () => void log.push("start"),
      gatewayHealthy: async () => true,
      finishInDashboard: async () => (log.push("finish"), { ok: true }),
    };
    return { log, deps: { ...base, ...over } };
  }

  it("stops, applies, starts, checks health, then finishes", async () => {
    const { log, deps: d } = deps();
    const res = await applyRestore(d);
    expect(log).toEqual(["stop", "engine apply", "start", "finish"]);
    expect(res).toEqual({ ok: true, report: { remapped: ["x"], review: [], missing_secrets: ["KEY"] } });
  });

  it("rolls back and restarts Chief when the restored setup doesn't come up", async () => {
    const { log, deps: d } = deps({ gatewayHealthy: async () => false });
    const res = await applyRestore(d);
    expect(log).toEqual(["stop", "engine apply", "start", "stop", "engine rollback", "start"]);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/previous setup was put back/);
  });

  it("a refused apply changes nothing and restarts Chief", async () => {
    const { log, deps: d } = deps({ engine: async (args) => (log.push(`engine ${args[0]}`), { ok: false, error: "Chief is still running. Stop it before restoring." }) });
    const res = await applyRestore(d);
    expect(log).toEqual(["stop", "engine apply", "start"]);
    expect(res).toEqual({ ok: false, error: "Chief is still running. Stop it before restoring." });
  });
});

/* ------------------------------------------------------------------ gateway ownership, secrets, settings */

describe("gatewayOwner", () => {
  const root = path.join(tmp, "hermes");
  const pidFile = path.join(root, "profiles", "chief", "gateway.pid");
  mkdirSync(path.dirname(pidFile), { recursive: true });
  const ours = "C:\\App\\payload\\bin\\hermes.exe";

  it("tells none, ours (an orphan) and another launcher's apart", () => {
    expect(gatewayOwner(root, ours)).toEqual({ state: "none" });
    writeFileSync(pidFile, JSON.stringify({ pid: 4242, argv: ["c:\\app\\payload\\bin\\HERMES.exe", "gateway", "run"] }));
    expect(gatewayOwner(root, ours, "chief", () => true)).toEqual({ state: "ours", pid: 4242 });
    expect(gatewayOwner(root, ours, "chief", () => false)).toEqual({ state: "none" });
    writeFileSync(pidFile, JSON.stringify({ pid: 4243, argv: ["D:\\Home\\x\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe", "gateway", "run"] }));
    expect(gatewayOwner(root, ours, "chief", () => true)).toMatchObject({ state: "foreign", pid: 4243 });
  });
});

describe("secrets and settings", () => {
  const sealer = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`sealed:${s}`), decryptString: (b: Buffer) => b.toString().replace(/^sealed:/, "") };

  it("creates the bridge token once, sealed, and keeps it", () => {
    const dir = path.join(tmp, "secrets");
    const first = bridgeToken(dir, sealer);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(readFileSync(path.join(dir, "bridge-token.bin"), "utf8")).toBe(`sealed:${first}`);
    expect(bridgeToken(dir, sealer)).toBe(first);
    expect(bridgeToken(dir, sealer, "adopted-token-from-existing-install-000000")).toBe("adopted-token-from-existing-install-000000");
    expect(() => bridgeToken(dir, { ...sealer, isEncryptionAvailable: () => false })).toThrow(/DPAPI/);
    // A token sealed under a key the app can no longer reach is replaced, not a dead end at start.
    const broken = { ...sealer, decryptString: () => { throw new Error("Error while decrypting the ciphertext"); } };
    const fresh = bridgeToken(dir, broken);
    expect(fresh.length).toBeGreaterThanOrEqual(32);
    expect(readdirSync(dir).some((f) => f.startsWith("bridge-token.unreadable-"))).toBe(true);
  });

  it("stores the shell's settings with defaults", () => {
    const dir = path.join(tmp, "app");
    const store = new Store(dir);
    expect(store.value.ports).toEqual({ ui: 3000, bridge: 7790 });
    store.save({ ports: { ui: 3004, bridge: 7791 }, closeNoticeShown: true });
    expect(new Store(dir).value).toMatchObject({ ports: { ui: 3004, bridge: 7791 }, closeNoticeShown: true, startAtLogin: true });
  });
});
