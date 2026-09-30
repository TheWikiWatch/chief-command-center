import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cleanRel, listDir, relFromAbsolute, resolveInVault, resolveLink, searchVault, VaultPathError } from "@/lib/server/vault";
import { linkifyVaultRefs, obsidianToMarkdown, parseVaultHref, splitFrontmatter, vaultHref } from "@/lib/vault-client";

let root = "";
let outside = "";
let junction = false;

beforeAll(() => {
  const base = mkdtempSync(path.join(tmpdir(), "vault-test-"));
  root = path.join(base, "Second Brain");
  outside = path.join(base, "outside");
  mkdirSync(path.join(root, "wiki", "reviews"), { recursive: true });
  mkdirSync(path.join(root, ".obsidian"));
  mkdirSync(outside);
  writeFileSync(path.join(root, "index.md"), "---\ntitle: Home\ntags: [a, b]\n---\n# Home\nSee [[Concrete Candles]].");
  writeFileSync(path.join(root, "wiki", "Concrete Candles.md"), "Pour-on-demand fulfillment notes.");
  writeFileSync(path.join(root, "wiki", "reviews", "2026-07-03 — Weekly Review.md"), "Weekly review body");
  writeFileSync(path.join(root, ".obsidian", "app.json"), "{}");
  writeFileSync(path.join(root, "state.db"), "x");
  writeFileSync(path.join(outside, "secret.txt"), "nope");
  try {
    symlinkSync(outside, path.join(root, "escape"), "junction");
    junction = true;
  } catch {
    junction = false;
  }
  process.env.CHIEF_VAULT_PATH = root;
});
afterAll(() => {
  delete process.env.CHIEF_VAULT_PATH;
  rmSync(path.dirname(root), { recursive: true, force: true });
});

describe("vault paths", () => {
  it("rejects traversal, absolute, stream and hidden paths", () => {
    for (const bad of ["../x", "wiki/../../x", "C:\\Windows\\win.ini", "C:/x", "index.md::$DATA", ".obsidian/app.json", "wiki/.hidden", "a\0b", "state.db"]) {
      expect(() => cleanRel(bad), bad).toThrow(VaultPathError);
    }
    expect(cleanRel("/wiki\\Concrete Candles.md")).toBe("wiki/Concrete Candles.md");
  });

  it("resolves inside the vault and refuses a junction that points outside", async () => {
    expect((await resolveInVault("wiki/Concrete Candles.md")).rel).toBe("wiki/Concrete Candles.md");
    if (junction) await expect(resolveInVault("escape/secret.txt")).rejects.toThrow(VaultPathError);
  });

  it("lists folders without hidden folders or databases", async () => {
    const names = (await listDir("")).map((e) => e.name);
    expect(names).toContain("wiki");
    expect(names).toContain("index.md");
    expect(names).not.toContain(".obsidian");
    expect(names).not.toContain("state.db");
    // A junction out of the vault is not listed (its folder count would describe the outside).
    if (junction) expect(names).not.toContain("escape");
  });

  it("finds notes by name and text, and resolves loose wikilinks", async () => {
    const hits = await searchVault("fulfillment");
    expect(hits[0].path).toBe("wiki/Concrete Candles.md");
    expect(await resolveLink("Concrete Candles")).toBe("wiki/Concrete Candles.md");
    expect(await resolveLink("2026-07-03 -- Weekly Review")).toBe("wiki/reviews/2026-07-03 — Weekly Review.md");
    expect(await resolveLink("Nope")).toBeNull();
    // The index never walks into the junction.
    if (junction) expect((await searchVault("nope")).length).toBe(0);
  });

  it("lists notes that link here, and rereads only files that changed", async () => {
    const { backlinks, linkKey } = await import("@/lib/server/vault");
    expect(linkKey("wiki/Concrete Candles#Pricing|candles")).toBe("concrete candles");
    expect((await backlinks("wiki/Concrete Candles.md")).map((l) => l.path)).toEqual(["index.md"]);
    expect(await backlinks("index.md")).toEqual([]);

    // A new line in one note shows up after the index refreshes; nothing else changes.
    const file = path.join(root, "wiki", "Concrete Candles.md");
    writeFileSync(file, "Pour-on-demand fulfillment notes. Kiln schedule too.");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 31_000);
    try {
      expect((await searchVault("kiln"))[0]?.path).toBe("wiki/Concrete Candles.md");
      expect((await searchVault("fulfillment"))[0]?.path).toBe("wiki/Concrete Candles.md");
    } finally {
      clock.mockRestore();
    }
  });

  it("ranks the note named exactly like the query first", async () => {
    writeFileSync(path.join(root, "wiki", "Concrete Candles Materials Sourcing.md"), "Concrete candles supplier list, concrete candles again.");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    try {
      const hits = await searchVault("concrete candles");
      expect(hits[0].path).toBe("wiki/Concrete Candles.md");
      expect(hits.map((h) => h.path)).toContain("wiki/Concrete Candles Materials Sourcing.md");
    } finally {
      clock.mockRestore();
    }
  });

  it("maps Chief's absolute paths into the vault only", async () => {
    expect(await relFromAbsolute(path.join(root, "wiki", "Concrete Candles.md"))).toBe("wiki/Concrete Candles.md");
    expect(await relFromAbsolute(path.join(outside, "secret.txt"))).toBeNull();
  });
});

describe("vault markdown", () => {
  it("splits front matter into properties", () => {
    const { props, body } = splitFrontmatter("---\ntitle: Home\ntags: [a, b]\naliases:\n  - One\n  - Two\nempty:\n---\n# Home");
    expect(props).toEqual([["title", "Home"], ["tags", ["a", "b"]], ["aliases", ["One", "Two"]]]);
    expect(body).toBe("# Home");
  });

  it("turns wikilinks, embeds and callouts into markdown, but not inside code", () => {
    const md = obsidianToMarkdown("See [[Concrete Candles|candles]] and [[Weekly#Wins]].\n![[photo.png]]\n> [!note] Heads up\n`see [[not a link]]` and `[[MEMORY.md]]`", "index.md");
    expect(md).toContain(`[candles](${vaultHref("Concrete Candles", "index.md")})`);
    expect(md).toContain("[Weekly › Wins]");
    expect(md).toContain("![photo](/api/vault/file?name=photo.png&from=index.md)");
    expect(md).toContain("> **Heads up**");
    expect(md).toContain("`see [[not a link]]`");
    expect(md).toContain(`[MEMORY](${vaultHref("MEMORY.md", "index.md")})`);
  });

  it("links vault paths and wikilinks in the chief's messages", async () => {
    (await import("@/lib/vault-client")).rememberVaultRoot(String.raw`E:\Second Brain`);
    const text = "Saved to `E:\\Second Brain\\wiki\\concepts\\Tech Help Client PC Assist Tool.md` and see [[Concrete Candles]]. Also E:/Second Brain/boards/Personal.md here.\n```\nE:\\Second Brain\\raw\\x.md\n```";
    const out = linkifyVaultRefs(text);
    expect(out).toContain("[Tech Help Client PC Assist Tool](#vault=");
    expect(out).toContain(`[Concrete Candles](${vaultHref("Concrete Candles")})`);
    expect(out).toContain("[Personal](#vault=E%3A%2FSecond%20Brain%2Fboards%2FPersonal.md)");
    expect(out).toContain("```\nE:\\Second Brain\\raw\\x.md\n```");
    expect(linkifyVaultRefs("No vault here.")).toBe("No vault here.");
    expect(parseVaultHref(vaultHref("wiki/a b.md", "index.md"))).toEqual({ ref: "wiki/a b.md", from: "index.md" });
  });
});

describe("mojibake repair", () => {
  it("undoes double-encoded dashes and quotes, and leaves real accents alone", async () => {
    const { repairMojibake } = await import("@/lib/vault-client");
    const once = new TextDecoder("windows-1252").decode(new TextEncoder().encode("1445–1450 “ok”"));
    const twice = new TextDecoder("windows-1252").decode(new TextEncoder().encode(once));
    expect(repairMojibake(twice)).toBe("1445–1450 “ok”");
    expect(repairMojibake(once)).toBe("1445–1450 “ok”");
    expect(repairMojibake("Café crème — naïve…")).toBe("Café crème — naïve…");
  });
});

describe("vault root on the client", () => {
  it("links and copies paths under a moved vault, and still links the old root's paths", async () => {
    const { absoluteVaultPath, rememberVaultRoot } = await import("@/lib/vault-client");
    rememberVaultRoot(String.raw`E:\Second Brain`);
    rememberVaultRoot(String.raw`D:\Notes\Brain\\`);
    try {
      expect(absoluteVaultPath("wiki/a b.md")).toBe(String.raw`D:\Notes\Brain\wiki\a b.md`);
      const out = linkifyVaultRefs(String.raw`See D:\Notes\Brain\wiki\Plan.md and E:\Second Brain\index.md.`);
      expect(out).toContain("[Plan](#vault=");
      expect(out).toContain("[index](#vault=");
      expect(linkifyVaultRefs(String.raw`D:\Notes\Other\x.md`)).toBe(String.raw`D:\Notes\Other\x.md`);
    } finally {
      rememberVaultRoot(String.raw`E:\Second Brain`);
    }
  });
});
