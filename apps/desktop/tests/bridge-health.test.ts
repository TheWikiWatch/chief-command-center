import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { bridgeHealth, healthProof } from "../src/gateway";

/* Security review S14: the app's token goes only to a bridge that first proves it already knows it. */

const TOKEN = "t".repeat(43);
let server: Server | null = null;

afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

function listen(answer: (req: IncomingMessage, url: URL) => { status: number; body: unknown }, seen: string[]): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      seen.push(String(req.headers.authorization || ""));
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const { status, body } = answer(req, url);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    }).listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port));
  });
}

describe("bridgeHealth", () => {
  it("a program squatting on the port never receives the token", async () => {
    const seen: string[] = [];
    const port = await listen(() => ({ status: 200, body: { ok: true, profile: "chief", proof: "made-up" } }), seen);
    const res = await bridgeHealth(port, TOKEN);
    expect(res.ok).toBe(false);
    expect(seen.join("")).not.toContain(TOKEN);
  });

  it("the real bridge proves itself, then gets the token", async () => {
    const seen: string[] = [];
    const port = await listen(
      (_req, url) =>
        url.pathname === "/health/proof"
          ? { status: 200, body: { ok: true, proof: healthProof(TOKEN, url.searchParams.get("nonce") || "") } }
          : { status: 200, body: { ok: true, profile: "chief", voice: true } },
      seen,
    );
    expect(await bridgeHealth(port, TOKEN)).toEqual({ ok: true, voice: true });
    expect(seen).toEqual(["", `Bearer ${TOKEN}`]);
  });
});
