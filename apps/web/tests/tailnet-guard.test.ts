// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy as middleware } from "@/proxy";
import { isDirectLoopback } from "@/lib/tailnet-guard";

const KEYS = ["CHIEF_DASHBOARD_TAILSCALE_USER", "CHIEF_PHONE_HOST", "CHIEF_PHONE_ACCESS"] as const;
const ORIGINAL = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});
const phoneOn = (host = "pc.example.ts.net", access?: "tailnet") => {
  process.env.CHIEF_PHONE_HOST = host;
  if (access) process.env.CHIEF_PHONE_ACCESS = access;
  else delete process.env.CHIEF_PHONE_ACCESS;
};

// What Tailscale Serve adds to every proxied request (ipn/ipnlocal/serve.go).
const serve = { "x-forwarded-for": "100.64.0.9", "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-proto": "https" };
const status = async (headers: Record<string, string>) =>
  (await middleware(new NextRequest("http://127.0.0.1:3000/api/bridge/health", { headers }))).status;
// Past the identity checks, an unpaired phone is asked to pair (lib/server/phone-devices.ts; phone-pairing.test.ts).
const asksToPair = async (headers: Record<string, string>) => {
  const res = await middleware(new NextRequest("http://127.0.0.1:3000/api/bridge/health", { headers }));
  return res.status === 401 && /Pair this phone/.test(await res.text());
};

describe("tailnet guard", () => {
  it("lets this PC's browser through on loopback", async () => {
    process.env.CHIEF_DASHBOARD_TAILSCALE_USER = "me@example.com";
    expect(await status({ host: "127.0.0.1:3000" })).toBe(200);
    expect(await status({ host: "localhost:3000" })).toBe(200);
    // What Next dev fills in from the socket before the proxy runs.
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(await status({ host: "127.0.0.1:3000", "x-forwarded-for": ip, "x-forwarded-proto": "http", "x-forwarded-host": "127.0.0.1:3000" })).toBe(200);
    }
  });

  it("does not trust a loopback Host that arrived through Serve", async () => {
    process.env.CHIEF_DASHBOARD_TAILSCALE_USER = "me@example.com";
    phoneOn();
    expect(await status({ host: "127.0.0.1:3000", ...serve })).toBe(401);
    expect(await status({ host: "127.0.0.1:3000", ...serve, "tailscale-user-login": "someone@example.com" })).toBe(401);
  });

  it("a program on this PC can't get in by adding a Tailscale login header", async () => {
    // Phone access off (the default): no request without this window's session gets in, whatever it claims.
    expect(await status({ host: "127.0.0.1:3000", "tailscale-user-login": "x" })).toBe(401);
    expect(await status({ host: "127.0.0.1:3000", ...serve, "tailscale-user-login": "x" })).toBe(401);
    expect(await status({ host: "pc.example.ts.net", ...serve, "tailscale-user-login": "x" })).toBe(401);
    // Phone access on for the owner: a loopback Host or another name is still refused, even with the owner's login.
    process.env.CHIEF_DASHBOARD_TAILSCALE_USER = "me@example.com";
    phoneOn();
    expect(await status({ host: "127.0.0.1:3000", ...serve, "tailscale-user-login": "me@example.com" })).toBe(401);
    expect(await status({ host: "localhost:3000", "tailscale-user-login": "me@example.com" })).toBe(401);
  });

  it("a website using DNS rebinding is refused", async () => {
    process.env.CHIEF_DASHBOARD_TAILSCALE_USER = "me@example.com";
    phoneOn();
    expect(await status({ host: "evil.example:3000", "tailscale-user-login": "me@example.com" })).toBe(401);
    expect(await status({ host: "evil.example:3000", ...serve, "tailscale-user-login": "me@example.com" })).toBe(401);
  });

  it("with no allowed account, only an explicit whole-tailnet choice lets other logins in", async () => {
    phoneOn();
    expect(await status({ host: "pc.example.ts.net", ...serve, "tailscale-user-login": "anyone@example.com" })).toBe(401);
    phoneOn("pc.example.ts.net", "tailnet");
    expect(await asksToPair({ host: "pc.example.ts.net:8443", ...serve, "tailscale-user-login": "anyone@example.com" })).toBe(true);
    expect(await status({ host: "pc.example.ts.net", "x-forwarded-proto": "http", "tailscale-user-login": "anyone@example.com" })).toBe(401);
  });

  it("any single Serve marker is enough to fall back to the login check", async () => {
    const local = { host: "127.0.0.1:3000", "x-forwarded-for": "127.0.0.1", "x-forwarded-proto": "http" };
    expect(isDirectLoopback(new Headers(local))).toBe(true);
    const serveMarkers: Record<string, string>[] = [
      { "x-forwarded-proto": "https" },
      { "x-forwarded-for": "100.64.0.9" },
      { "x-forwarded-for": "127.0.0.1, 100.64.0.9" },
      { "x-forwarded-for": "fd7a:115c:a1e0::1" },
      { "tailscale-user-login": "me@example.com" },
    ];
    for (const extra of serveMarkers) {
      expect(isDirectLoopback(new Headers({ ...local, ...extra }))).toBe(false);
    }
  });

  it("lets the allowlisted Serve login on the tailnet name as far as pairing", async () => {
    process.env.CHIEF_DASHBOARD_TAILSCALE_USER = "me@example.com";
    phoneOn();
    expect(await asksToPair({ host: "pc.example.ts.net", ...serve, "tailscale-user-login": "me@example.com" })).toBe(true);
    expect(await status({ host: "pc.example.ts.net", ...serve })).toBe(401);
  });
});
