import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterAll, describe, expect, it } from "vitest";

import { Logger, pipeToLog, rotate } from "../src/logger";

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

  it("keeps reading a child's output once its log can't be written (a full disk), so the child never blocks", async () => {
    // Before: no one listened for the log's error. Node stopped piping into it, the output was no longer read, and a
    // child blocks on its next write once its pipe is full (the error itself was thrown in the main process too).
    const output = new PassThrough({ highWaterMark: 1024 });
    const log = new Writable({ highWaterMark: 1024, write: (_chunk, _encoding, done) => done(Object.assign(new Error("no space left on device"), { code: "ENOSPC" })) });
    pipeToLog(log, [output, null]);
    const chunk = Buffer.alloc(4096, 1);
    let written = 0;
    const pump = async () => {
      for (let i = 0; i < 256; i++) {
        if (!output.write(chunk)) await new Promise((r) => output.once("drain", r));
        written += chunk.length;
      }
    };
    await Promise.race([pump(), new Promise((_, reject) => setTimeout(() => reject(new Error("the output stopped being read")), 5000))]);
    expect(written).toBe(256 * 4096); // a megabyte, far past every buffer on the way
  });
});
