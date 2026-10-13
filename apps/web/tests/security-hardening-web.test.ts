// @vitest-environment node
import { readFileSync } from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { signInUrl } from "@/lib/connections";
import { proxy } from "@/proxy";
import { POST as bridgePost } from "@/app/api/bridge/[...path]/route";

/* Security review, low items: sign-in links, cross-site API calls, headers, folder routes from a phone. */

const ORIGINAL = process.env.CHIEF_SESSION_SECRET;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CHIEF_SESSION_SECRET;
  else process.env.CHIEF_SESSION_SECRET = ORIGINAL;
});

describe("sign-in links", () => {
  it("opens only https addresses without credentials", () => {
    expect(signInUrl("https://accounts.example.com/o/auth?x=1")).toBe("https://accounts.example.com/o/auth?x=1");
    for (const bad of ["javascript:alert(1)", "http://example.com/", "file:///C:/x", "data:text/html,x", `https://u:p${"@"}example.com/`, "not a url"]) {
      expect(signInUrl(bad), bad).toBe("");
    }
  });
});

describe("the request gate", () => {
  const ask = (pathname: string, site: string) =>
    proxy(new NextRequest(`http://127.0.0.1:3000${pathname}`, { headers: { host: "127.0.0.1:3000", "sec-fetch-site": site } }));

  it("refuses API calls another site (or another local port) makes from a browser", async () => {
    delete process.env.CHIEF_SESSION_SECRET;
    expect((await ask("/api/bridge/approve", "cross-site")).status).toBe(403);
    expect((await ask("/api/bridge/approve", "same-site")).status).toBe(403);
    expect((await ask("/api/bridge/approve", "same-origin")).status).toBe(200);
    expect((await ask("/", "cross-site")).status).toBe(200); // a link to the page itself is fine
  });

  it("sends isolation headers", () => {
    // next.config.ts is the build's own module (not importable here): its header list, read as text.
    const config = readFileSync(path.join(__dirname, "..", "next.config.ts"), "utf8");
    expect(config).toContain('{ key: "Cross-Origin-Opener-Policy", value: "same-origin" }');
    expect(config).toContain('{ key: "Cross-Origin-Resource-Policy", value: "same-origin" }');
  });
});

describe("folder routes", () => {
  it("choosing the Second Brain folder works only from the PC itself", async () => {
    const viaPhone = new NextRequest("https://pc.example.ts.net/api/bridge/setup/second-brain", {
      method: "POST",
      headers: { host: "pc.example.ts.net", origin: "https://pc.example.ts.net", "x-forwarded-for": "100.64.0.9", "x-forwarded-proto": "https", "content-type": "application/json" },
      body: JSON.stringify({ path: "D:\Notes" }),
    });
    const res = await bridgePost(viaPhone, { params: Promise.resolve({ path: ["setup", "second-brain"] }) });
    expect(res.status).toBe(403);
  });
});
