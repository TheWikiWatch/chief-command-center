// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "@/middleware";
import { isDirectLoopback } from "@/lib/tailnet-guard";

const ORIGINAL = process.env.CHIEF_DASHBOARD_TAILSCALE_USER;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CHIEF_DASHBOARD_TAILSCALE_USER;
  else process.env.CHIEF_DASHBOARD_TAILSCALE_USER = ORIGINAL;
});

// What Tailscale Serve adds to every proxied request (ipn/ipnlocal/serve.go).
const serve = { "x-forwarded-for": "100.64.0.9", "x-forwarded-host": "127.0.0.1:3000", "x-forwarded-proto": "https" };
const status = async (headers: Record<string, string>) =>
  (await middleware(new NextRequest("http://127.0.0.1:3000/api/bridge/health", { headers }))).status;

describe("tailnet guard", () => {
  it("lets this PC's browser through on loopback", async () => {
    process.env.CHIEF_DASHBOARD_TAILSCALE_USER = "me@example.com";
    expect(await status({ host: "127.0.0.1:3000" })).toBe(200);
    expect(await status({ host: "localhost:3000" })).toBe(200);
    // What Next dev fills in from the socket before middleware runs.
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(await status({ host: "127.0.0.1:3000", "x-forwarded-for": ip, "x-forwarded-proto": "http", "x-forwarded-host": "127.0.0.1:3000" })).toBe(200);
    }
  });

  it("does not trust a loopback Host that arrived through Serve", async () => {
    process.env.CHIEF_DASHBOARD_TAILSCALE_USER = "me@example.com";
    expect(await status({ host: "127.0.0.1:3000", ...serve })).toBe(401);
    expect(await status({ host: "127.0.0.1:3000", ...serve, "tailscale-user-login": "someone@example.com" })).toBe(401);
    expect(await status({ host: "127.0.0.1:3000", ...serve, "tailscale-user-login": "me@example.com" })).toBe(200);
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

  it("still admits the allowlisted Serve login on the tailnet name", async () => {
    process.env.CHIEF_DASHBOARD_TAILSCALE_USER = "me@example.com";
    expect(await status({ host: "pc.example.ts.net", ...serve, "tailscale-user-login": "me@example.com" })).toBe(200);
    expect(await status({ host: "pc.example.ts.net", ...serve })).toBe(401);
  });
});
