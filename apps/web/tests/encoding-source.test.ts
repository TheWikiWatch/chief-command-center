import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findMojibakeMarkers } from "@/lib/encoding-guard";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git" || name === "backups" || name === ".runtime") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?|css)$/.test(name) && !name.includes(".bak")) out.push(p);
  }
  return out;
}

describe("source encoding guard", () => {
  it("UI/runtime sources have no double-encoded UTF-8 markers", () => {
    const files = walk(process.cwd()).filter((p) => /[\\/](components|lib|app)[\\/]/.test(p));
    const bad: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const hits = findMojibakeMarkers(text);
      if (hits.length) bad.push(file + ": " + hits.join(","));
    }
    expect(bad).toEqual([]);
  });
});
