import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { choosePort, consentUrl, disableServe, enableServe, parseServe, parseStatus, phoneUrl, readState, type Exec } from "../src/tailscale";

const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "desk.example-tailnet.ts.net.", UserID: 42 },
  User: { "42": { LoginName: "owner@example.com" }, "7": { LoginName: "guest@example.com" } },
  CertDomains: ["desk.example-tailnet.ts.net"],
});

const SERVE = JSON.stringify({
  TCP: { "443": { HTTPS: true }, "8443": { HTTPS: true } },
  Web: {
    "desk.example-tailnet.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
    "desk.example-tailnet.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:7420" } } },
  },
});

describe("reading Tailscale", () => {
  it("finds this PC's name, owner and whether HTTPS certificates are on", () => {
    expect(parseStatus(STATUS)).toEqual({ backend: "Running", dnsName: "desk.example-tailnet.ts.net", login: "owner@example.com", https: true });
    expect(parseStatus(JSON.stringify({ BackendState: "NeedsLogin", CertDomains: null }))).toEqual({ backend: "NeedsLogin", dnsName: "", login: "", https: false });
  });

  it("lists HTTPS Serve entries and marks the one that serves the dashboard", () => {
    expect(parseServe(SERVE, 3000)).toEqual([
      { port: 443, target: "http://127.0.0.1:3000", ours: true },
      { port: 8443, target: "http://127.0.0.1:7420", ours: false },
    ]);
    expect(parseServe(SERVE, 3001).every((e) => !e.ours)).toBe(true);
    expect(parseServe(JSON.stringify({ Web: { "h:443": { Handlers: { "/": { Proxy: "localhost:3000" } } } } }), 3000)[0].ours).toBe(true);
    expect(parseServe("{}", 3000)).toEqual([]);
    expect(parseServe("", 3000)).toEqual([]);
  });

  it("reads the state through the CLI, and only asks about Serve when Tailscale runs", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (_f, args) => (calls.push(args), { code: 0, out: args[0] === "status" ? STATUS : SERVE });
    const state = await readState(3000, "tailscale.exe", exec);
    expect(state.serve.find((e) => e.ours)?.port).toBe(443);
    expect(calls).toEqual([["status", "--json"], ["serve", "status", "--json"]]);
    expect((await readState(3000, "", exec)).installed).toBe(false);
    const stopped = await readState(3000, "tailscale.exe", async () => ({ code: 0, out: JSON.stringify({ BackendState: "Stopped" }) }));
    expect(stopped).toMatchObject({ installed: true, backend: "Stopped", serve: [] });
    expect((await readState(3000, "tailscale.exe", async () => ({ code: 1, out: "failed to connect" }))).error).toMatch(/isn't answering/);
  });
});

describe("choosing the Serve port", () => {
  const entries = parseServe(SERVE, 3001);
  it("keeps the dashboard's own port, else takes 443, else the first free Serve port", () => {
    expect(choosePort(parseServe(SERVE, 3000))).toBe(443);
    expect(choosePort([])).toBe(443);
    expect(choosePort(entries)).toBe(10000); // 443 and 8443 serve other things
    expect(choosePort([...entries, { port: 10000, target: "x", ours: false }])).toBeNull();
  });
  it("accepts a chosen port only when Serve allows it and it's free", () => {
    expect(choosePort(entries, 10000)).toBe(10000);
    expect(choosePort(entries, 8443)).toBeNull();
    expect(choosePort(entries, 3000)).toBeNull();
  });
  it("builds the phone's address", () => {
    expect(phoneUrl("desk.example-tailnet.ts.net", 443)).toBe("https://desk.example-tailnet.ts.net");
    expect(phoneUrl("desk.example-tailnet.ts.net", 8443)).toBe("https://desk.example-tailnet.ts.net:8443");
    expect(phoneUrl("", 443)).toBe("");
  });
});

/** A child process stand-in for `tailscale serve`. */
function fakeSpawn(script: (child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; kill: () => void }) => void) {
  const seen: string[][] = [];
  const impl = ((_file: string, args: string[]) => {
    seen.push(args);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, killed: false, kill() {
      this.killed = true;
    } });
    setTimeout(() => script(child), 0);
    return child;
  }) as never;
  return { impl, seen };
}

describe("changing Serve", () => {
  it("adds only the dashboard's entry, in the background, without prompts", async () => {
    const sp = fakeSpawn((c) => {
      c.exitCode = 0;
      c.emit("close", 0);
    });
    expect(await enableServe("tailscale.exe", 443, 3000, sp.impl)).toEqual({ ok: true, port: 443 });
    expect(sp.seen[0]).toEqual(["serve", "--bg", "--yes", "--https=443", "http://127.0.0.1:3000"]);
  });

  it("returns Tailscale's consent link instead of waiting on it", async () => {
    const sp = fakeSpawn((c) => c.stdout.emit("data", "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n"));
    const r = await enableServe("tailscale.exe", 443, 3000, sp.impl, 2000);
    expect(r).toEqual({ ok: false, error: "Tailscale needs your permission first.", consentUrl: "https://login.tailscale.com/f/serve?node=abc123" });
    expect(consentUrl("nothing here")).toBe("");
  });

  it("explains a refusal in plain words", async () => {
    const sp = fakeSpawn((c) => {
      c.stderr.emit("data", "Access denied: serve config denied\n");
      c.exitCode = 1;
      c.emit("close", 1);
    });
    const r = await enableServe("tailscale.exe", 443, 3000, sp.impl);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/refused the change for this Windows account/);
  });

  it("turns off only its own port's entry", async () => {
    const calls: string[][] = [];
    const r = await disableServe("tailscale.exe", 443, 3000, async (_f, args) => (calls.push(args), { code: 0, out: "" }));
    expect(r).toEqual({ ok: true, port: 443 });
    expect(calls[0]).toEqual(["serve", "--yes", "--https=443", "http://127.0.0.1:3000", "off"]);
    expect(calls.flat()).not.toContain("reset");
  });
});
