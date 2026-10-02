import path from "node:path";
import { pathToFileURL } from "node:url";

import { SERVE_PORTS } from "./tailscale";
import { parseGithub } from "./release-source";

/**
 * Trust decisions for the window and its IPC, kept pure so they can be tested. Origins are compared as parsed
 * origins, never as string prefixes: a user-info look-alike (the origin, then "@" and another host) and
 * `http://127.0.0.1:30001/` both start with `http://127.0.0.1:3000`, and a popup that passes inherits the
 * preload (the whole `chiefDesktop` API).
 */

/** The URL's origin, or "" when it doesn't parse (or has none, like `about:blank`). */
export function originOf(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === "null" ? "" : u.origin;
  } catch {
    return "";
  }
}

export function sameOrigin(url: string, origin: string): boolean {
  return !!origin && originOf(url) === origin;
}

/** The boot page as a file URL, the only `file:` page the window may show. */
export function bootUrl(staticDir: string): string {
  return pathToFileURL(path.join(staticDir, "boot.html")).href;
}

/** `file:///…/boot.html` matches with or without a query or fragment; any other file doesn't. */
export function isBootPage(url: string, boot: string): boolean {
  try {
    const u = new URL(url);
    const b = new URL(boot);
    return u.protocol === "file:" && decodeURIComponent(u.pathname).toLowerCase() === decodeURIComponent(b.pathname).toLowerCase();
  } catch {
    return false;
  }
}

export type OpenDecision = "allow" | "external" | "deny";

/** A link that asks for a new window: the dashboard's own pages open in-app; web links go to the browser. */
export function windowOpenDecision(url: string, origin: string): OpenDecision {
  if (sameOrigin(url, origin)) return "allow";
  if (/^https?:\/\//i.test(url) && originOf(url)) return "external";
  return "deny";
}

export type NavigateDecision = "allow" | "external" | "deny";

/** The window itself navigating: only the dashboard and the boot page stay in the window. */
export function navigateDecision(url: string, origin: string, boot: string): NavigateDecision {
  if (sameOrigin(url, origin) || isBootPage(url, boot)) return "allow";
  if (/^https?:\/\//i.test(url) && originOf(url)) return "external";
  return "deny";
}

/** IPC may come only from the dashboard (or, for boot channels, the boot page) in the main frame's origin. */
export function senderAllowed(frameUrl: string | undefined, origin: string, boot: string, opts: { boot?: boolean } = {}): boolean {
  if (!frameUrl) return false;
  if (sameOrigin(frameUrl, origin)) return true;
  return !!opts.boot && isBootPage(frameUrl, boot);
}

/** A port Tailscale Serve can use for HTTPS. */
export function validServePort(value: unknown): number | undefined {
  return typeof value === "number" && (SERVE_PORTS as readonly number[]).includes(value) ? value : undefined;
}

/**
 * An update source the owner may type: a GitHub releases repository, or a local absolute folder. Network shares
 * (`\\host\share`, `//host`) are refused: Windows signs in to a share automatically, which hands the account's
 * NTLM hash to whoever runs it. An empty string clears the saved source.
 */
export function validFeed(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length > 400 || /[\0\r\n]/.test(text)) return null;
  if (parseGithub(text)) return text;
  if (/^[\\/]{2}/.test(text) || /^\\\\\?\\UNC\\/i.test(text)) return null;
  if (/^[A-Za-z]:[\\/]/.test(text)) return text;
  return null;
}

/** Dialog options from the page: a title and a starting folder, both plain strings of sane length. */
export function dialogOptions(value: unknown): { title?: string; defaultPath?: string } {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const title = typeof v.title === "string" ? v.title.slice(0, 200) : undefined;
  const start = typeof v.defaultPath === "string" ? v.defaultPath.trim() : "";
  const defaultPath = start && start.length <= 400 && /^[A-Za-z]:[\\/]/.test(start) ? start : undefined;
  return { title, defaultPath };
}

/** File filters from the page: names and bare extensions only. */
export function fileFilters(value: unknown): { name: string; extensions: string[] }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .slice(0, 10)
    .filter((f): f is { name: unknown; extensions: unknown } => !!f && typeof f === "object")
    .map((f) => ({
      name: String(f.name ?? "").slice(0, 80),
      extensions: Array.isArray(f.extensions) ? f.extensions.map(String).filter((e) => /^[A-Za-z0-9*]{1,12}$/.test(e)).slice(0, 20) : [],
    }))
    .filter((f) => f.extensions.length);
  return out.length ? out : undefined;
}
