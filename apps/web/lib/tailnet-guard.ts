const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function hostnameOf(hostHeader: string | null): string {
  const raw = (hostHeader || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    return end > 0 ? raw.slice(1, end) : raw;
  }
  const colon = raw.lastIndexOf(":");
  if (colon > -1 && /^\d+$/.test(raw.slice(colon + 1))) {
    return raw.slice(0, colon);
  }
  return raw;
}

export function isLoopbackHost(hostHeader: string | null): boolean {
  return LOCAL_HOSTS.has(hostnameOf(hostHeader));
}

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function everyListed(value: string | null, ok: (item: string) => boolean): boolean {
  return !value || value.split(",").every((item) => ok(item.trim().toLowerCase()));
}

/**
 * Loopback Host alone is spoofable: Tailscale Serve routes by SNI and forwards the client's
 * Host unchanged. Serve always sets X-Forwarded-Proto: https and X-Forwarded-For to the
 * tailnet client, and a client cannot override either. Next dev fills these in from the
 * socket (http, 127.0.0.1) before the proxy runs, so judge their values, not presence.
 */
export function isDirectLoopback(headers: Headers): boolean {
  return (
    isLoopbackHost(headers.get("host")) &&
    !headers.has("tailscale-user-login") &&
    everyListed(headers.get("x-forwarded-proto"), (proto) => proto === "http") &&
    everyListed(headers.get("x-forwarded-for"), (ip) => LOOPBACK_IPS.has(ip))
  );
}

export function tailscaleAllowlist(raw = process.env.CHIEF_DASHBOARD_TAILSCALE_USER || ""): string[] {
  return raw
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function decodeTailscaleLogin(header: string | null): string {
  const value = (header || "").trim();
  if (!value) return "";
  // Serve RFC-2047-encodes non-ASCII. Email logins stay ASCII.
  const match = /^=\?utf-8\?q\?(.+)\?=$/i.exec(value);
  if (!match) return value.toLowerCase();
  try {
    return match[1].replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

/**
 * Phone access as the desktop app set it (apps/desktop/src/runtime.ts): this PC's own Tailscale name, the only Host a
 * request that came through Serve may carry, and whether the whole tailnet may use it. No name: phone access is off.
 */
export function phoneAccess(env: NodeJS.ProcessEnv = process.env): { host: string; tailnet: boolean } {
  return { host: (env.CHIEF_PHONE_HOST || "").trim().toLowerCase().replace(/\.$/, ""), tailnet: env.CHIEF_PHONE_ACCESS === "tailnet" };
}

/**
 * A request shaped like Tailscale Serve's: phone access is on, the Host is this PC's Tailscale name (a page using DNS
 * rebinding, or a request typed by a program on this PC to 127.0.0.1, carries another), and the scheme Serve set is
 * https. Headers alone can be forged by a program on this PC, so this narrows who can try, it doesn't prove identity.
 */
export function viaPhoneServe(headers: Headers, phoneHost: string): boolean {
  return (
    !!phoneHost &&
    hostnameOf(headers.get("host")) === phoneHost &&
    (headers.get("x-forwarded-proto") || "").split(",").every((p) => p.trim().toLowerCase() === "https")
  );
}

/** The Tailscale account allowed in: the owner's (allow-list), or anyone on the tailnet only when that was chosen. */
export function allowRemoteLogin(login: string, allowlist: string[], wholeTailnet = false): boolean {
  if (!login) return false;
  if (allowlist.length === 0) return wholeTailnet;
  return allowlist.includes(login);
}
