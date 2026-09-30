"use client";

import { useSyncExternalStore } from "react";

/** Client side of the read-only Vault tab (PLAN-2026-09-23 §4). */
export type VaultKind = "note" | "image" | "pdf" | "video" | "audio" | "canvas" | "text" | "other";
export type VaultEntry = { name: string; path: string; dir: boolean; kind?: VaultKind; size?: number; mtime: number; count?: number };
export type VaultHit = { path: string; name: string; kind: VaultKind; snippet?: string };

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, cache: "no-store" });
  const data = (await res.json().catch(() => ({ ok: false, error: "The vault did not answer" }))) as T & { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) throw new Error(data.error || "The vault could not be read");
  return data;
}

/* ---------------------------------------------------------------- where the vault lives */

let rootPath = "";
/** Every vault root this page has been told about: a moved vault's old paths still link. */
const knownRoots = new Set<string>();

/** The vault folder on the PC, as last reported by the server (app config or the vault routes). */
export const vaultRootPath = () => rootPath;
export function rememberVaultRoot(next: string | undefined) {
  if (!next || !next.trim()) return;
  rootPath = next.trim().replace(/[\\/]+$/, "");
  knownRoots.add(rootPath.toLowerCase());
}
/** Full Windows path of a vault-relative path, for copying. */
export const absoluteVaultPath = (rel: string) => `${rootPath}\\${rel.replace(/\//g, "\\")}`;

export async function vaultTree(dir: string, signal?: AbortSignal) {
  const data = await getJson<{ dir: string; root: string; rootPath?: string; entries: VaultEntry[] }>(
    `/api/vault/tree?dir=${encodeURIComponent(dir)}`,
    signal,
  );
  rememberVaultRoot(data.rootPath);
  return data;
}
export const vaultSearch = (q: string, signal?: AbortSignal) =>
  getJson<{ hits: VaultHit[] }>(`/api/vault/search?q=${encodeURIComponent(q)}`, signal);
export const vaultResolve = (ref: string, from?: string) =>
  getJson<{ path: string; kind: VaultKind; heading: string }>(
    `/api/vault/resolve?ref=${encodeURIComponent(ref)}${from ? `&from=${encodeURIComponent(from)}` : ""}`,
  );
export const vaultBacklinks = (path: string, signal?: AbortSignal) =>
  getJson<{ links: { path: string; name: string }[] }>(`/api/vault/backlinks?path=${encodeURIComponent(path)}`, signal);
export const vaultFileUrl = (path: string, download = false) =>
  `/api/vault/file?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;
export const vaultEmbedUrl = (name: string, from: string) =>
  `/api/vault/file?name=${encodeURIComponent(name)}&from=${encodeURIComponent(from)}`;
export async function vaultText(path: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(vaultFileUrl(path), { signal, cache: "no-store" });
  if (!res.ok) throw new Error(res.status === 404 ? "This file is no longer in the vault" : "The vault could not be read");
  return res.text();
}

export const kindOfName = (name: string): VaultKind => {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (ext === "md" || ext === "markdown") return "note";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
  if (ext === "pdf") return "pdf";
  if (["mp4", "webm", "mov", "m4v"].includes(ext)) return "video";
  if (["mp3", "m4a", "wav", "ogg", "opus"].includes(ext)) return "audio";
  if (ext === "canvas") return "canvas";
  if (["txt", "py", "sh", "json", "yaml", "yml", "csv", "ts", "js", "ps1", "toml", "css", "html", "xml"].includes(ext)) return "text";
  return "other";
};

export const displayName = (name: string) => name.replace(/\.md$/i, "");

/* ---------------------------------------------------------------- "open this in the vault" */

type OpenRequest = { ref: string; from?: string; at: number };
let pending: OpenRequest | null = null;
const openListeners = new Set<() => void>();

/** Ask the Vault tab to open something (a vault path, an absolute E:\Second Brain path or a [[link]]). */
export function openInVault(ref: string, from?: string) {
  pending = { ref, from, at: Date.now() };
  for (const fn of openListeners) fn();
}
export function takeVaultOpen(): OpenRequest | null {
  const next = pending;
  pending = null;
  return next;
}
function subscribeOpen(fn: () => void) {
  openListeners.add(fn);
  return () => {
    openListeners.delete(fn);
  };
}
/** Changes whenever something asks to open a vault file (the shell switches tabs on it). */
export function useVaultOpenSignal(): number {
  return useSyncExternalStore(subscribeOpen, () => pending?.at ?? 0, () => 0);
}

/* ---------------------------------------------------------------- recents */

const RECENTS = "chief-vault-recents";
export type Recent = { path: string; at: number };
export function loadRecents(): Recent[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENTS) || "[]");
    return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.path === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}
export function rememberRecent(path: string) {
  try {
    const next = [{ path, at: Date.now() }, ...loadRecents().filter((r) => r.path !== path)].slice(0, 8);
    localStorage.setItem(RECENTS, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}

/* ---------------------------------------------------------------- markdown helpers (pure, tested) */

export type Frontmatter = { props: [string, string | string[]][]; body: string };

/** Obsidian front matter (simple YAML: scalars, [a, b] and "- item" lists) split from the body. */
export function splitFrontmatter(md: string): Frontmatter {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(md);
  if (!m) return { props: [], body: md };
  const props: [string, string | string[]][] = [];
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const last = props[props.length - 1];
      (last[1] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_\- ]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    if (!value) {
      props.push([key, []]);
      listKey = key;
    } else if (/^\[.*\]$/.test(value)) {
      props.push([key, value.slice(1, -1).split(",").map((v) => unquote(v.trim())).filter(Boolean)]);
      listKey = null;
    } else {
      props.push([key, unquote(value)]);
      listKey = null;
    }
  }
  return { props: props.filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v !== "")), body: md.slice(m[0].length) };
}
const unquote = (v: string) => v.replace(/^["']|["']$/g, "");

/** Apply `fn` only outside fenced and inline code (inline code that is exactly one [[link]] still links). */
function outsideCode(md: string, fn: (text: string) => string): string {
  return md
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 ? (/^`\[\[[^\]\n]+\]\]`$/.test(part) ? fn(part.slice(1, -1)) : part) : fn(part)))
    .join("");
}

export const vaultHref = (ref: string, from?: string) =>
  `#vault=${encodeURIComponent(ref)}${from ? `&from=${encodeURIComponent(from)}` : ""}`;

export function parseVaultHref(href: string | null): { ref: string; from?: string } | null {
  if (!href || !href.startsWith("#vault=")) return null;
  const params = new URLSearchParams(href.slice(1));
  const ref = params.get("vault");
  return ref ? { ref, from: params.get("from") || undefined } : null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/** Obsidian note → plain markdown: wikilinks become Vault links, image embeds become images, callouts get a title. */
export function obsidianToMarkdown(body: string, from: string): string {
  return outsideCode(body, (text) =>
    text
      .replace(/!\[\[([^\]\n]+?)\]\]/g, (_, inner: string) => {
        const [target] = inner.split("|");
        const name = target.trim();
        if (IMAGE_EXT.test(name)) return `![${(name.split("/").pop() || name).replace(/\.[^.]+$/, "")}](${vaultEmbedUrl(name, from)})`;
        return `[${displayName(name.split("/").pop() || name)}](${vaultHref(name, from)})`;
      })
      .replace(/\[\[([^\]\n]+?)\]\]/g, (_, inner: string) => {
        const [target, alias] = inner.split("|");
        const [file, heading] = target.split("#");
        const label = (alias || (heading && !file ? heading : displayName((file || "").split("/").pop() || file) + (heading ? ` › ${heading}` : ""))).trim();
        return `[${label.replace(/[[\]]/g, "")}](${vaultHref(target.trim(), from)})`;
      })
      .replace(/^(>\s*)\[!([a-z]+)\][+-]?\s*(.*)$/gim, (_, lead: string, type: string, title: string) => `${lead}**${title || type[0].toUpperCase() + type.slice(1)}**`),
  );
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Paths the chief writes under a known vault root, with either slash. No vault yet: matches nothing. */
function rootPattern() {
  if (!knownRoots.size) return "(?!)";
  return [...knownRoots].map((r) => r.split(/[\\/]+/).filter(Boolean).map(escapeRe).join("[\\\\/]+")).join("|");
}
const FILE_EXT = "(?:md|markdown|png|jpe?g|gif|webp|pdf|mp4|mov|webm|mp3|m4a|wav|canvas|txt|csv|json|py)";

/**
 * Chief's messages: turn vault paths (backticked or plain) and [[wikilinks]] into Vault links.
 * Code blocks and other inline code are left alone.
 */
export function linkifyVaultRefs(text: string): string {
  const root = rootPattern();
  const VAULT_ROOT = new RegExp(`(?:${root})[\\\\/]+`, "i");
  if (!text.includes("[[") && !VAULT_ROOT.test(text)) return text;
  const parts = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g);
  return parts
    .map((part, i) => {
      if (i % 2) {
        // Inline code that is exactly a vault path becomes a link; other code stays code.
        const inner = part.startsWith("```") ? null : part.slice(1, -1).trim();
        if (inner && VAULT_ROOT.test(inner) && !/\n/.test(inner)) {
          const name = inner.split(/[\\/]/).pop() || inner;
          return `[${displayName(name)}](${vaultHref(inner)})`;
        }
        return part;
      }
      return part
        .replace(new RegExp(`(?:${root})[\\\\/]+[^\\n\`*|<>"]*?\\.${FILE_EXT}\\b`, "gi"), (abs) => {
          const name = abs.split(/[\\/]/).pop() || abs;
          return `[${displayName(name)}](${vaultHref(abs)})`;
        })
        .replace(/(?<!!)\[\[([^\]\n]+?)\]\]/g, (_, inner: string) => {
          const [target, alias] = inner.split("|");
          const label = alias || displayName(target.split("#")[0].split("/").pop() || target);
          return `[${label.trim()}](${vaultHref(target.trim())})`;
        });
    })
    .join("");
}

/* ---------------------------------------------------------------- display-only mojibake repair */

// Windows-1252 bytes 0x80–0x9F map to these characters; everything else in 0xA0–0xFF is Latin-1.
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};
const SUSPECT = /[Â-ô][\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™ -ÿ]+/g;

function undoOnce(run: string): string | null {
  const bytes: number[] = [];
  for (const ch of run) {
    const code = ch.codePointAt(0)!;
    if (code <= 0xff) bytes.push(code);
    else if (CP1252[code] !== undefined) bytes.push(CP1252[code]);
    else return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/**
 * Text that was UTF-8, read as Windows-1252 and saved again (once or twice) shows a dash as a run of
 * accented Latin letters and symbols (the classic "A-circumflex, euro sign" look).
 * Undo that for display only; runs that don't decode cleanly are left exactly as they are.
 */
export function repairMojibake(text: string): string {
  if (!/[Â-ô][\u0080-¿€‚-„‘’™Œœ]/.test(text)) return text;
  return text.replace(SUSPECT, (run) => {
    let current = run;
    for (let i = 0; i < 3; i += 1) {
      const next = undoOnce(current);
      if (next === null || next === current) break;
      current = next;
    }
    return current;
  });
}
