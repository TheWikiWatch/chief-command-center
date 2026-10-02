/**
 * The desktop app's per-launch session secret (`CHIEF_SESSION_SECRET`).
 *
 * Loopback is shared by every process on the PC, including other Windows users' sessions, so "came from
 * 127.0.0.1" proves nothing about who is asking. When the desktop app runs the dashboard it generates a secret
 * each launch, hands it to the server, and sets it as an httpOnly cookie on its own window. The proxy (proxy.ts) then
 * admits a direct-loopback request only with that cookie. Opening Chief in a browser on the same PC goes
 * through a short-lived signed ticket from the desktop app (tray → Open in browser), which the proxy
 * swaps for the cookie. Phones keep using their Tailscale identity. Without the variable (development servers)
 * nothing changes.
 */

export const TICKET_PARAM = "open";
const TICKET_TTL_MS = 60_000;

export function sessionSecret(env: Record<string, string | undefined> = process.env): string {
  return (env.CHIEF_SESSION_SECRET || "").trim();
}

/** The cookie is per port: two installs (or a dev server) on 127.0.0.1 share one cookie jar. */
export function sessionCookieName(hostHeader: string | null): string {
  const port = /:(\d+)$/.exec((hostHeader || "").trim())?.[1] || "80";
  return `chief_session_${port}`;
}

/** Constant-time string comparison (both sides are short ASCII). */
export function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(secret: string, text: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(text));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `<expires ms>.<hmac>`: what the desktop app puts in the "open in browser" link (it signs the same way). */
export async function makeTicket(secret: string, now = Date.now()): Promise<string> {
  const expires = now + TICKET_TTL_MS;
  return `${expires}.${await hmacHex(secret, `open:${expires}`)}`;
}

export async function ticketValid(ticket: string, secret: string, now = Date.now()): Promise<boolean> {
  const m = /^(\d{13})\.([0-9a-f]{64})$/.exec(ticket || "");
  if (!m || !secret) return false;
  const expires = Number(m[1]);
  if (expires < now || expires > now + TICKET_TTL_MS) return false;
  return sameSecret(m[2], await hmacHex(secret, `open:${expires}`));
}

/** Paths that answer without the session: the desktop app's readiness probe only. */
export function sessionExempt(pathname: string): boolean {
  return pathname === "/api/healthz";
}
