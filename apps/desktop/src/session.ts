import { createHmac, randomBytes } from "node:crypto";

/**
 * The dashboard's per-launch session secret (apps/web/lib/loopback-session.ts). Loopback is shared by every
 * process on the PC, so the dashboard admits a direct loopback request only with this secret as a cookie: the
 * app sets it on its own window, and a browser on this PC gets it through a short-lived signed ticket.
 */
export function newSessionSecret(): string {
  return randomBytes(32).toString("hex");
}

export function sessionCookieName(uiPort: number): string {
  return `chief_session_${uiPort}`;
}

const TICKET_TTL_MS = 60_000;

/** `<expires ms>.<hmac>`, signed exactly as the dashboard checks it. */
export function openTicket(secret: string, now = Date.now()): string {
  const expires = now + TICKET_TTL_MS;
  return `${expires}.${createHmac("sha256", secret).update(`open:${expires}`).digest("hex")}`;
}
