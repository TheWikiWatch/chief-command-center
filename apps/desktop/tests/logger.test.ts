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

  it("redacts key shapes, JSON secrets, private keys and the Windows user name", () => {
    const log = new Logger(() => tmp);
    // Assembled so the privacy scan doesn't read the samples as real secrets.
    const pem = ["-----BEGIN PRIVATE", " KEY-----\nMIIBVQ\n-----END PRIVATE", " KEY-----"].join("");
    const home = ["C:", "Users", ""].join("\\"); // the user name after it, assembled for the privacy scan
    const out = log.redact(
      [`{"api_key": "abcdef123456", "access_token": "zzzzzz999999"}`, `AI${"za"}${"S".repeat(35)}`, `hf_${"a".repeat(30)}`, `123456789:${"A".repeat(35)}`, `ey${"J"}aaaaaaaaaa.ey${"J"}bbbbbbbbbb.cccccccccc`, pem, `${home}Someone\\AppData\\x.log`, `${home}Public\\y`].join(" | "),
    );
    expect(out).not.toMatch(/abcdef123456|zzzzzz999999|SSSSSSSS|aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|AAAAAAAAAA|bbbbbbbbbb|MIIBVQ|Someone/);
    expect(out).toContain("C:\\Users\\<user>\\AppData");
    expect(out).toContain(`${home}Public`);
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
