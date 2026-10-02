// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { makeTicket, sameSecret, sessionCookieName, ticketValid } from "@/lib/loopback-session";
import { proxy as middleware } from "@/proxy";
import { openTicket, sessionCookieName as desktopCookieName } from "../../desktop/src/session";

const SECRET = "a".repeat(64);
const ORIGINAL = process.env.CHIEF_SESSION_SECRET;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CHIEF_SESSION_SECRET;
  else process.env.CHIEF_SESSION_SECRET = ORIGINAL;
});

const ask = (path: string, headers: Record<string, string> = {}) =>
  middleware(new NextRequest(`http://127.0.0.1:3000${path}`, { headers: { host: "127.0.0.1:3000", ...headers } }));

describe("the desktop app's loopback session", () => {
  it("changes nothing when the app didn't set a secret (development servers)", async () => {
    delete process.env.CHIEF_SESSION_SECRET;
    expect((await ask("/api/bridge/approve")).status).toBe(200);
  });

  it("refuses a loopback request without the window's cookie, page or API", async () => {
    process.env.CHIEF_SESSION_SECRET = SECRET;
    expect((await ask("/api/bridge/approve")).status).toBe(401);
    expect((await ask("/")).status).toBe(401);
    expect((await ask("/", { cookie: `chief_session_3000=${"b".repeat(64)}` })).status).toBe(401);
    // Another port's cookie (a second install) doesn't count.
    expect((await ask("/", { cookie: `chief_session_3001=${SECRET}` })).status).toBe(401);
  });

  it("admits the window's cookie, and the readiness probe without one", async () => {
    process.env.CHIEF_SESSION_SECRET = SECRET;
    expect((await ask("/api/bridge/approve", { cookie: `chief_session_3000=${SECRET}` })).status).toBe(200);
    expect((await ask("/api/healthz")).status).toBe(200);
  });

  it("swaps a fresh ticket for the cookie and removes it from the address", async () => {
    process.env.CHIEF_SESSION_SECRET = SECRET;
    const res = await ask(`/?open=${await makeTicket(SECRET)}&tab=today`);
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:3000/?tab=today");
    const cookie = res.headers.get("set-cookie") || "";
    expect(cookie).toContain(`chief_session_3000=${SECRET}`);
    expect(cookie.toLowerCase()).toContain("httponly");
    expect(cookie.toLowerCase()).toContain("samesite=strict");
  });

  it("refuses an expired, forged or far-future ticket", async () => {
    expect(await ticketValid(await makeTicket(SECRET, Date.now() - 120_000), SECRET)).toBe(false);
    expect(await ticketValid(await makeTicket("c".repeat(64)), SECRET)).toBe(false);
    expect(await ticketValid(`${Date.now() + 3_600_000}.${"0".repeat(64)}`, SECRET)).toBe(false);
    expect(await ticketValid("junk", SECRET)).toBe(false);
    expect(await ticketValid(await makeTicket(SECRET), SECRET)).toBe(true);
  });

  it("accepts the desktop app's own tickets and cookie name", async () => {
    expect(await ticketValid(openTicket(SECRET), SECRET)).toBe(true);
    expect(desktopCookieName(3000)).toBe(sessionCookieName("127.0.0.1:3000"));
  });

  it("names the cookie per port and compares secrets fully", () => {
    expect(sessionCookieName("127.0.0.1:3000")).toBe("chief_session_3000");
    expect(sessionCookieName("localhost:3001")).toBe("chief_session_3001");
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abd")).toBe(false);
    expect(sameSecret("abc", "ab")).toBe(false);
    expect(sameSecret("", "")).toBe(false);
  });
});
