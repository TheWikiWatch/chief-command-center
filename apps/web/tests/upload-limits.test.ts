import { describe, expect, it } from "vitest";
import { admitFiles, MAX_ATTACHMENTS, MAX_TOTAL_BYTES } from "@/lib/upload-limits";

const MB = 1024 * 1024;
const file = (name: string, mb: number) => ({ name, size: mb * MB });

describe("composer upload limits", () => {
  it("keeps the whole message under the Next middleware and bridge caps", () => {
    // base64 is 4/3 of the file; the bridge accepts 80 MB of JSON and Next buffers 110 MB.
    expect((MAX_TOTAL_BYTES * 4) / 3).toBeLessThan(80 * MB - 1 * MB);
  });

  it("accepts a 20 MB phone video that used to be truncated", () => {
    expect(admitFiles([], [file("clip.mp4", 20)])).toEqual({ accepted: [file("clip.mp4", 20)], error: "" });
  });

  it("rejects a single file over 25 MB but keeps the rest", () => {
    const result = admitFiles([], [file("big.mov", 26), file("ok.png", 1)]);
    expect(result.accepted.map((f) => f.name)).toEqual(["ok.png"]);
    expect(result.error).toContain("big.mov is over 25 MB");
  });

  it("counts files already attached toward the 55 MB total", () => {
    const result = admitFiles([file("a.mp4", 24), file("b.mp4", 24)], [file("c.mp4", 10), file("d.png", 2)]);
    expect(result.accepted.map((f) => f.name)).toEqual(["d.png"]);
    expect(result.error).toContain("c.mp4 would take this message over 55 MB");
  });

  it("stops at the file count limit", () => {
    const current = Array.from({ length: MAX_ATTACHMENTS - 1 }, (_, i) => file(`f${i}`, 0.1));
    const result = admitFiles(current, [file("last", 0.1), file("extra", 0.1)]);
    expect(result.accepted.map((f) => f.name)).toEqual(["last"]);
    expect(result.error).toBe(`Attach up to ${MAX_ATTACHMENTS} files at a time.`);
  });
});
