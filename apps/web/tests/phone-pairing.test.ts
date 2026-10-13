// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { proxy } from "@/proxy";
import { createPairingCode, DEVICE_COOKIE, deviceAllowed, listDevices, redeemPairingCode, removeDevice, resetPairingForTests } from "@/lib/server/phone-devices";

/* Phone pairing (security review S1): headers alone never let a phone in; a device cookie from a one-time code does. */

const KEYS = ["CHIEF_APP_DATA", "CHIEF_DASHBOARD_TAILSCALE_USER", "CHIEF_PHONE_HOST", "CHIEF_PHONE_ACCESS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "chief-pair-"));
  process.env.CHIEF_APP_DATA = dir;
  process.env.CHIEF_DASHBOARD_TAILSCALE_USER = "me@example.com";
  process.env.CHIEF_PHONE_HOST = "pc.example.ts.net";
  delete process.env.CHIEF_PHONE_ACCESS;
  resetPairingForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const serve = { host: "pc.example.ts.net", "x-forwarded-proto": "https", "x-forwarded-for": "100.64.0.9", "tailscale-user-login": "me@example.com" };
const phone = (pathname: string, cookie = "") =>
  proxy(new NextRequest(`https://pc.example.ts.net${pathname}`, { headers: { ...serve, ...(cookie ? { cookie: `${DEVICE_COOKIE}=${cookie}` } : {}) } }));

describe("pairing codes", () => {
  it("a code works once, and the device it makes is recognised", () => {
    const { code } = createPairingCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const first = redeemPairingCode(code.toLowerCase().replace("-", " "), "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)");
    expect(first.ok).toBe(true);
    expect(redeemPairingCode(code).ok).toBe(false); // once only
    const cookie = (first as { cookie: string }).cookie;
    expect(deviceAllowed(cookie)).toBe(true);
    expect(deviceAllowed(cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A"))).toBe(false);
    expect(listDevices()).toMatchObject([{ name: "iPhone" }]);
    // Only a hash of the token is kept on the PC.
    expect(readFileSync(path.join(dir, "phone-devices.json"), "utf8")).not.toContain(cookie.split(".")[1]);
  });

  it("an expired code is refused, and wrong guesses lock pairing for a while", () => {
    const { code } = createPairingCode(Date.now() - 11 * 60_000);
    expect(redeemPairingCode(code).ok).toBe(false);
    for (let i = 0; i < 9; i++) redeemPairingCode("WRONG-CODE");
    const good = createPairingCode().code;
    const locked = redeemPairingCode(good);
    expect(locked).toEqual({ ok: false, error: expect.stringMatching(/Too many wrong codes/) });
  });

  it("removing a phone signs it out", () => {
    const res = redeemPairingCode(createPairingCode().code) as { ok: true; cookie: string };
    expect(removeDevice(listDevices()[0].id)).toBe(true);
    expect(deviceAllowed(res.cookie)).toBe(false);
  });
});

describe("the gate", () => {
  it("an unpaired phone, or a program faking Serve's headers, only reaches the pairing page", async () => {
    const page = await phone("/");
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("https://pc.example.ts.net/pair");
    expect((await phone("/api/bridge/transcript")).status).toBe(401);
    expect((await phone("/api/bridge/approve")).status).toBe(401);
    expect((await phone("/pair")).status).toBe(200);
  });

  it("a paired phone gets in", async () => {
    const res = redeemPairingCode(createPairingCode().code) as { ok: true; cookie: string };
    expect((await phone("/", res.cookie)).status).toBe(200);
    expect((await phone("/api/bridge/health", res.cookie)).status).toBe(200);
    expect((await phone("/", "made-up.cookie-value-that-is-long-enough")).status).toBe(307);
  });

  it("a paired phone still needs phone access on and the allowed account", async () => {
    const res = redeemPairingCode(createPairingCode().code) as { ok: true; cookie: string };
    expect((await proxy(new NextRequest("https://pc.example.ts.net/", { headers: { ...serve, "tailscale-user-login": "someone@example.com", cookie: `${DEVICE_COOKIE}=${res.cookie}` } }))).status).toBe(401);
    delete process.env.CHIEF_PHONE_HOST;
    expect((await phone("/", res.cookie)).status).toBe(401);
  });
});
