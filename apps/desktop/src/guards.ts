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

/**
 * The boot page's own scheme. With the `grantFileProtocolExtraPrivileges` fuse off, a `file://` page can't load
 * from inside app.asar, so the boot page is served by the main process under this privileged scheme instead
 * (boot-protocol.ts), and the window never shows a `file:` page at all.
 */
export const BOOT_SCHEME = "chief-boot";
export const BOOT_URL = `${BOOT_SCHEME}://app/boot.html`;

/** The boot page, with or without a query or fragment; nothing else under the scheme. */
export function isBootPage(url: string, boot: string = BOOT_URL): boolean {
  try {
    const u = new URL(url);
    const b = new URL(boot);
    return u.protocol === b.protocol && u.host === b.host && u.pathname === b.pathname;
  } catch {
    return false;
  }
}

export type OpenDecision = "allow" | "external" | "deny";

/** An e-mail draft (Report a problem): the system's mail app opens it; the address must look like one. */
export function isMailto(url: string): boolean {
  return /^mailto:[^\s@/?#]+@[^\s@/?#]+\.[^\s@/?#]+(\?[^\s]*)?$/i.test(url);
}

/** A link that asks for a new window: the dashboard's own pages open in-app; web links go to the browser. */
export function windowOpenDecision(url: string, origin: string): OpenDecision {
  if (sameOrigin(url, origin)) return "allow";
  if (/^https?:\/\//i.test(url) && originOf(url)) return "external";
  if (isMailto(url)) return "external";
  return "deny";
}

export type NavigateDecision = "allow" | "external" | "deny";

/** The window itself navigating: only the dashboard and the boot page stay in the window. */
export function navigateDecision(url: string, origin: string, boot: string): NavigateDecision {
  if (sameOrigin(url, origin) || isBootPage(url, boot)) return "allow";
  if (/^https?:\/\//i.test(url) && originOf(url)) return "external";
  if (isMailto(url)) return "external";
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

/** What the dashboard may ask Chromium for: the microphone (audio only), notifications, writing to the
 * clipboard and full screen. Everything else (camera, location, HID, USB, serial, MIDI, screen capture…) is
 * refused, and so is any request from a page that isn't the dashboard. */
const ALLOWED_PERMISSIONS = new Set(["media", "notifications", "clipboard-sanitized-write", "fullscreen"]);

export function permissionAllowed(permission: string, requestingUrl: string, origin: string, mediaTypes: readonly string[] = []): boolean {
  if (!sameOrigin(requestingUrl, origin) || !ALLOWED_PERMISSIONS.has(permission)) return false;
  if (permission === "media") return mediaTypes.length > 0 && mediaTypes.every((t) => t === "audio");
  return true;
}

/** Synchronous permission checks (navigator.permissions.query, enumerating devices): the same list, where a
 * media check with no type stated is allowed so the page can see whether a microphone exists. */
export function permissionCheckAllowed(permission: string, requestingOrigin: string, origin: string, mediaType?: string): boolean {
  if (originOf(requestingOrigin) !== origin && requestingOrigin !== origin) return false;
  if (!ALLOWED_PERMISSIONS.has(permission)) return false;
  if (permission === "media") return !mediaType || mediaType === "audio" || mediaType === "unknown";
  return true;
}

/** Shortcuts from the taskbar jump list and the tray, passed to a launch as `--action=<id>`. */
export const DESKTOP_ACTIONS = [
  { id: "new-thread", title: "New thread", description: "Start a new thread with Chief" },
  { id: "voice", title: "Voice mode", description: "Talk with Chief" },
  { id: "today", title: "Today", description: "See what to do first" },
] as const;
export type DesktopAction = (typeof DESKTOP_ACTIONS)[number]["id"];

/** The action a launch asks for (only the known ones; anything else on the command line is ignored). */
export function actionFromArgv(argv: readonly string[]): DesktopAction | null {
  for (const arg of argv) {
    const m = /^--action=([a-z-]+)$/.exec(arg);
    const found = m && DESKTOP_ACTIONS.find((a) => a.id === m[1]);
    if (found) return found.id;
  }
  return null;
}
