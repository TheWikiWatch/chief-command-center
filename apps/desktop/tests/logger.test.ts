import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Logger, rotate } from "../src/logger";

const tmp = mkdtempSync(path.join(tmpdir(), "chief-logger-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("the desktop log", () => {
  it("writes one JSON object per line and never writes a secret", () => {
    const secret = "a".repeat(20) + "SECRETVALUE";
    const log = new Logger(() => tmp, "main.jsonl", () => new Date("2026-10-02T10:00:00Z"));
    log.addSecret(secret);
    log.info("boot step", { step: "gateway", detail: `token ${secret}` });
    log.warn("fetch", { url: "http://127.0.0.1:3000/?open=abcdef123456", header: "Bearer abcdefghijklmnop" });
    log.error("crash", { error: new Error("boom") });
    const lines = readFileSync(path.join(tmp, "main.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ at: "2026-10-02T10:00:00.000Z", level: "info", event: "boot step", step: "gateway", detail: "token [redacted]" });
    expect(lines[1].url).toBe("http://127.0.0.1:3000/?open=[redacted]");
    expect(lines[1].header).toBe("Bearer [redacted]");
    expect(lines[2].error.message).toBe("boom");
    expect(readFileSync(path.join(tmp, "main.jsonl"), "utf8")).not.toContain("SECRETVALUE");
  });

  it("rotates a full file, keeping the newest few", () => {
    const file = path.join(tmp, "rot.log");
    for (let i = 0; i < 5; i++) {
      writeFileSync(file, `round ${i} `.repeat(20));
      rotate(file, 100, 3);
    }
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.1`, "utf8")).toContain("round 4");
    expect(readFileSync(`${file}.3`, "utf8")).toContain("round 2");
    expect(existsSync(`${file}.4`)).toBe(false);
  });
});
