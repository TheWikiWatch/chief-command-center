import { promises as fs } from "node:fs";
import path from "node:path";

import { deniedFilePath } from "@/lib/proxy-policy";
import { opsUrl } from "@/lib/server/app-config";
import { secondBrain } from "@/lib/server/second-brain";

/**
 * Read-only access to the Second Brain vault for the Vault tab (PLAN-2026-09-23 §4).
 * Every path is resolved and must stay inside the vault (symlinks included); nothing here writes.
 */
export type VaultKind = "note" | "image" | "pdf" | "video" | "audio" | "canvas" | "text" | "other";
export type VaultEntry = { name: string; path: string; dir: boolean; kind?: VaultKind; size?: number; mtime: number; count?: number };

const HIDDEN = new Set([".obsidian", ".git", ".trash", "_trash", ".stfolder", "node_modules", "__pycache__"]);
const EXT_KIND: Record<string, VaultKind> = {
  md: "note", markdown: "note",
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", svg: "image",
  pdf: "pdf",
  mp4: "video", webm: "video", mov: "video", m4v: "video",
  mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", opus: "audio",
  canvas: "canvas",
  txt: "text", py: "text", sh: "text", json: "text", yaml: "text", yml: "text", csv: "text", ts: "text", js: "text", ps1: "text", toml: "text", css: "text", html: "text", xml: "text",
};
export const MIME: Record<string, string> = {
  md: "text/plain; charset=utf-8", markdown: "text/plain; charset=utf-8",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg",
  canvas: "text/plain; charset=utf-8",
};

export const extOf = (name: string) => (name.includes(".") ? name.split(".").pop()!.toLowerCase() : "");
export const kindOf = (name: string): VaultKind => EXT_KIND[extOf(name)] || "other";
export const mimeOf = (name: string) => MIME[extOf(name)] || (kindOf(name) === "text" ? "text/plain; charset=utf-8" : "application/octet-stream");

let rootCache: { at: number; root: string } | null = null;

/**
 * The vault folder: the Second Brain (CHIEF_VAULT_PATH, else the folder Chief was set up with), else an
 * Ops-compatible service's vault_path (cached for a minute). None of these: there is no vault, and every
 * vault route says so.
 */
export async function vaultRoot(): Promise<string> {
  const configured = (await secondBrain()).path;
  if (configured) return configured;
  const base = opsUrl();
  if (!base) throw new VaultPathError("not configured");
  if (rootCache && Date.now() - rootCache.at < 60_000) return rootCache.root;
  let root = rootCache?.root || "";
  try {
    const res = await fetch(`${base}/api/settings`, { signal: AbortSignal.timeout(2000), cache: "no-store" });
    const data = (await res.json()) as { vault_path?: string };
    if (typeof data.vault_path === "string" && data.vault_path.trim()) root = data.vault_path.trim();
  } catch {
    /* Ops API down: keep the last known vault */
  }
  if (!root) throw new VaultPathError("not configured");
  rootCache = { at: Date.now(), root: path.resolve(root) };
  return rootCache.root;
}

export class VaultPathError extends Error {}

/** Normalize a vault-relative path (forward slashes, no leading slash). Rejects anything that could escape. */
export function cleanRel(raw: string): string {
  const input = String(raw ?? "");
  if (input.includes("\0")) throw new VaultPathError("bad path");
  const slashed = input.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (/^[A-Za-z]:/.test(slashed) || slashed.startsWith("//")) throw new VaultPathError("absolute paths are not allowed");
  if (slashed.includes(":")) throw new VaultPathError("bad path");
  const parts = slashed.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) throw new VaultPathError("bad path");
  if (parts.some((p) => HIDDEN.has(p) || (p.startsWith(".") && p.length > 1))) throw new VaultPathError("hidden");
  const rel = parts.join("/");
  if (rel && deniedFilePath(rel)) throw new VaultPathError("denied");
  return rel;
}

/** Absolute path of a vault-relative path, after following symlinks; throws unless it stays inside the vault. */
export async function resolveInVault(rel: string): Promise<{ root: string; abs: string; rel: string }> {
  const root = await vaultRoot();
  const clean = cleanRel(rel);
  const rootReal = await fs.realpath(root);
  const abs = path.resolve(rootReal, clean);
  const real = await fs.realpath(abs).catch(() => {
    throw new VaultPathError("not found");
  });
  const inside = real === rootReal || real.toLowerCase().startsWith((rootReal + path.sep).toLowerCase());
  if (!inside) throw new VaultPathError("outside the vault");
  return { root: rootReal, abs: real, rel: clean };
}

/** Turn an absolute path the chief wrote (E:\Second Brain\...) into a vault-relative one, if it is inside. */
export async function relFromAbsolute(raw: string): Promise<string | null> {
  const root = await vaultRoot();
  const norm = path.resolve(String(raw).replace(/\//g, path.sep));
  const prefix = root.toLowerCase() + path.sep;
  if (!norm.toLowerCase().startsWith(prefix)) return null;
  return norm.slice(prefix.length).split(path.sep).join("/");
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export async function listDir(rel: string): Promise<VaultEntry[]> {
  const { abs, rel: clean } = await resolveInVault(rel);
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const out: VaultEntry[] = [];
  for (const d of dirents) {
    if (HIDDEN.has(d.name) || d.name.startsWith(".")) continue;
    // Links and junctions are skipped, as in the search index: listing one would stat (and count)
    // whatever it points to, even outside the vault.
    if (d.isSymbolicLink()) continue;
    const child = clean ? `${clean}/${d.name}` : d.name;
    if (!d.isDirectory() && deniedFilePath(child)) continue;
    try {
      const st = await fs.stat(path.join(abs, d.name));
      if (st.isDirectory()) {
        const count = (await fs.readdir(path.join(abs, d.name))).filter((n) => !n.startsWith(".") && !HIDDEN.has(n)).length;
        out.push({ name: d.name, path: child, dir: true, mtime: st.mtimeMs, count });
      } else if (st.isFile()) {
        out.push({ name: d.name, path: child, dir: false, kind: kindOf(d.name), size: st.size, mtime: st.mtimeMs });
      }
    } catch {
      /* vanished or unreadable: skip */
    }
  }
  return out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : collator.compare(a.name, b.name)));
}

/* ------------------------------------------------------------------ index + search */

type Indexed = {
  path: string;
  name: string;
  lower: string;
  kind: VaultKind;
  mtime: number;
  size: number;
  text?: string;
  /** Notes only: link targets ([[x]], ![[x]]) as loose keys, for "Linked from". */
  links?: string[];
};
let index: { root: string; at: number; files: Indexed[] } | null = null;
let building: Promise<Indexed[]> | null = null;
const MAX_TEXT = 400_000;

/** The key a wikilink target and a note name share: lowercase file name, no .md, no heading or alias. */
export function linkKey(target: string): string {
  const file = target.split("|")[0].split("#")[0].trim().replace(/\\/g, "/");
  return looseKey((file.split("/").pop() || file).replace(/\.md$/i, ""));
}

function linksIn(text: string): string[] {
  const keys = new Set<string>();
  for (const m of text.matchAll(/!?\[\[([^\]\n]+?)\]\]/g)) {
    const key = linkKey(m[1]);
    if (key) keys.add(key);
  }
  return [...keys];
}

/**
 * Walk the vault. Files whose size and modified time are unchanged since the last walk keep their
 * text from `prior`, so a rebuild only stats the tree and reads what actually changed.
 */
async function walk(root: string, rel: string, out: Indexed[], prior: Map<string, Indexed>) {
  const dir = path.join(root, rel);
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    if (HIDDEN.has(d.name) || d.name.startsWith(".")) continue;
    const child = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) await walk(root, child, out, prior);
    else if (d.isFile() && !deniedFilePath(child)) {
      try {
        const st = await fs.stat(path.join(root, child));
        const old = prior.get(child);
        if (old && old.mtime === st.mtimeMs && old.size === st.size) {
          out.push(old);
          continue;
        }
        const kind = kindOf(d.name);
        const entry: Indexed = { path: child, name: d.name, lower: child.toLowerCase(), kind, mtime: st.mtimeMs, size: st.size };
        if ((kind === "note" || kind === "text") && st.size <= MAX_TEXT) entry.text = await fs.readFile(path.join(root, child), "utf8");
        if (kind === "note" && entry.text) entry.links = linksIn(entry.text);
        out.push(entry);
      } catch {
        /* skip */
      }
    }
  }
}

/** All files, refreshed at most every 30s; only changed files are read again. */
export async function vaultIndex(): Promise<Indexed[]> {
  const root = await fs.realpath(await vaultRoot());
  if (index && index.root === root && Date.now() - index.at < 30_000) return index.files;
  if (!building) {
    const prior = new Map(index && index.root === root ? index.files.map((f) => [f.path, f] as const) : []);
    building = (async () => {
      const files: Indexed[] = [];
      await walk(root, "", files, prior);
      index = { root, at: Date.now(), files };
      return files;
    })().finally(() => {
      building = null;
    });
  }
  return building;
}

/** Start building the index in the background (the Vault tab opening is a good hint a search is coming). */
export function warmVaultIndex() {
  void vaultIndex().catch(() => undefined);
}

/** Notes that link to `rel` with [[…]] or ![[…]], nearest folder first. */
export async function backlinks(rel: string, limit = 50): Promise<{ path: string; name: string }[]> {
  const clean = cleanRel(rel);
  const key = linkKey(clean);
  if (!key) return [];
  const files = await vaultIndex();
  const dir = clean.split("/").slice(0, -1).join("/").toLowerCase();
  return files
    .filter((f) => f.path !== clean && f.links?.includes(key))
    .sort((a, b) => Number(b.lower.startsWith(dir)) - Number(a.lower.startsWith(dir)) || collator.compare(a.name, b.name))
    .slice(0, limit)
    .map((f) => ({ path: f.path, name: f.name }));
}

/** Length of a leading front-matter block ("---" ... "---"), or 0. */
function frontmatterLength(text: string): number {
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (!text.startsWith("---", start)) return 0;
  const end = text.indexOf("\n---", start + 3);
  if (end < 0) return 0;
  const after = text.indexOf("\n", end + 4);
  return after < 0 ? text.length : after + 1;
}

export type SearchHit = { path: string; name: string; kind: VaultKind; snippet?: string; score: number };

export async function searchVault(q: string, limit = 40): Promise<SearchHit[]> {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!terms.length) return [];
  const whole = terms.join(" ");
  const files = await vaultIndex();
  const hits: SearchHit[] = [];
  for (const f of files) {
    const base = f.name.toLowerCase().replace(/\.md$/, "");
    let score = 0;
    let all = true;
    let snippet: string | undefined;
    const lowerText = f.text?.toLowerCase();
    // Snippets come from the note body, not its front matter.
    const bodyStart = f.text ? frontmatterLength(f.text) : 0;
    for (const t of terms) {
      const inName = base.includes(t);
      const inPath = !inName && f.lower.includes(t);
      const at = lowerText ? lowerText.indexOf(t) : -1;
      if (!inName && !inPath && at < 0) {
        all = false;
        break;
      }
      score += inName ? (base === t ? 60 : base.startsWith(t) ? 40 : 25) : inPath ? 10 : 0;
      if (at >= 0) {
        score += 3;
        if (!snippet && f.text && lowerText) {
          const inBody = lowerText.indexOf(t, bodyStart);
          const pos = inBody >= 0 ? inBody : at;
          const start = Math.max(inBody >= 0 ? bodyStart : 0, pos - 60);
          const raw = f.text.slice(start, pos + 120);
          const clean = raw.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a: string, b?: string) => b || a).replace(/[#*_`>|]+|^-{3,}|\s-{3,}\s/gm, " ").replace(/\s+/g, " ").trim();
          snippet = (start > bodyStart ? "…" : "") + clean + "…";
        }
      }
    }
    if (!all) continue;
    if (f.kind === "note") score += 2;
    // The whole query as the note's name ("concrete candles" → Concrete Candles.md) beats notes that merely contain it.
    if (terms.length > 1) score += base === whole ? 100 : base.startsWith(whole) ? 30 : 0;
    hits.push({ path: f.path, name: f.name, kind: f.kind, snippet, score });
  }
  return hits.sort((a, b) => b.score - a.score || collator.compare(a.path, b.path)).slice(0, limit);
}

const looseKey = (name: string) => name.toLowerCase().replace(/\s*(?:--|—|–)\s*/g, "-").replace(/\s+/g, " ").trim();

/** Resolve an Obsidian link target ([[Name]], [[folder/Name]], ![[image.png]]) to a vault path. */
export async function resolveLink(target: string, from?: string): Promise<string | null> {
  const raw = target.split("#")[0].split("|")[0].trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw) return from || null;
  const files = await vaultIndex();
  const want = raw.toLowerCase();
  const wantMd = /\.[a-z0-9]{1,6}$/i.test(raw) ? want : `${want}.md`;
  const exact = files.find((f) => f.lower === wantMd);
  if (exact) return exact.path;
  const bySuffix = files.filter((f) => f.lower.endsWith(`/${wantMd}`) || f.lower === wantMd);
  let pool = bySuffix.length ? bySuffix : files.filter((f) => f.name.toLowerCase() === wantMd.split("/").pop());
  // Obsidian users type "--" for "—" and vary spacing: compare loosely as a last resort.
  if (!pool.length) {
    const loose = looseKey(wantMd.split("/").pop() || "");
    pool = files.filter((f) => looseKey(f.name) === loose);
  }
  if (!pool.length) return null;
  // Prefer the candidate closest to the note that links to it.
  const dir = from ? from.split("/").slice(0, -1).join("/").toLowerCase() : "";
  pool.sort((a, b) => Number(b.lower.startsWith(dir)) - Number(a.lower.startsWith(dir)) || a.path.length - b.path.length);
  return pool[0].path;
}
