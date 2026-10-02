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

export function allowRemoteLogin(login: string, allowlist: string[]): boolean {
  if (!login) return false;
  if (allowlist.length === 0) return true;
  return allowlist.includes(login);
}
