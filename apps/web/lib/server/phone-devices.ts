import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

/*
 * Paired phones (security review 2026-10-12, S1). A request that came through Tailscale Serve carries headers any
 * program on the PC could also send, so a phone proves itself with a credential of its own: a device cookie it got
 * once, by redeeming a short one-time code the PC shows (Settings → Phone). The PC keeps only each device's id, name
 * and a SHA-256 of its token, in `<CHIEF_APP_DATA>/phone-devices.json`; removing a phone there signs it out.
 */

export const DEVICE_COOKIE = "chief_device";
const CODE_TTL_MS = 10 * 60_000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L: read off a screen and typed on a phone
const MAX_FAILURES = 10; // wrong codes in a window, then every code is refused until it passes
const FAILURE_WINDOW_MS = 10 * 60_000;
const SEEN_EVERY_MS = 60 * 60_000;

export type PhoneDevice = { id: string; name: string; hash: string; created: string; lastSeen: string };

type Pending = { expires: number };
type State = { codes: Map<string, Pending>; failures: { count: number; since: number }; cache: { mtime: number; devices: PhoneDevice[] } | null };

// One state per server process (module reloads in development keep it).
const g = globalThis as unknown as { __chiefPhonePairing?: State };
const state: State = (g.__chiefPhonePairing ??= { codes: new Map(), failures: { count: 0, since: 0 }, cache: null });

function file(): string {
  const dir = (process.env.CHIEF_APP_DATA || "").trim();
  return dir ? path.join(dir, "phone-devices.json") : "";
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function loadDevices(): PhoneDevice[] {
  const f = file();
  if (!f) return [];
  try {
    const mtime = statSync(f).mtimeMs;
    if (state.cache && state.cache.mtime === mtime) return state.cache.devices;
    const raw = JSON.parse(readFileSync(f, "utf8")) as { devices?: unknown };
    const devices = (Array.isArray(raw.devices) ? raw.devices : []).filter(
      (d): d is PhoneDevice => !!d && typeof d === "object" && /^[\w-]{8,64}$/.test(String((d as PhoneDevice).id)) && /^[0-9a-f]{64}$/.test(String((d as PhoneDevice).hash)),
    );
    state.cache = { mtime, devices };
    return devices;
  } catch {
    return [];
  }
}

function saveDevices(devices: PhoneDevice[]) {
  const f = file();
  if (!f) throw new Error("This install has no app data folder (CHIEF_APP_DATA).");
  mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ devices }, null, 2));
  renameSync(tmp, f);
  state.cache = null;
}

/** A new one-time pairing code (`ABCD-EFGH`), valid for ten minutes. Only the PC's own window asks for one. */
export function createPairingCode(now = Date.now()): { code: string; expiresAt: number } {
  for (const [code, p] of state.codes) if (p.expires < now) state.codes.delete(code);
  let raw = "";
  for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  state.codes.set(raw, { expires: now + CODE_TTL_MS });
  return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: now + CODE_TTL_MS };
}

function deviceName(userAgent: string): string {
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Android/i.test(userAgent)) return /Mobile/i.test(userAgent) ? "Android phone" : "Android tablet";
  if (/Windows/i.test(userAgent)) return "Windows PC";
  if (/Mac OS X/i.test(userAgent)) return "Mac";
  return "Phone";
}

export type Redeemed = { ok: true; cookie: string } | { ok: false; error: string };

/** Trade a code for this phone's device cookie (`<id>.<token>`). Once per code; too many wrong codes lock it out. */
export function redeemPairingCode(input: string, userAgent = "", now = Date.now()): Redeemed {
  if (now - state.failures.since > FAILURE_WINDOW_MS) state.failures = { count: 0, since: now };
  if (state.failures.count >= MAX_FAILURES) return { ok: false, error: "Too many wrong codes. Wait ten minutes, then get a new code on the PC." };
  const code = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const pending = state.codes.get(code);
  if (!pending || pending.expires < now) {
    state.failures.count += 1;
    return { ok: false, error: "That code isn't right, or it has expired. Get a new one on the PC: Settings, then Phone." };
  }
  state.codes.delete(code);
  const id = randomBytes(9).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  const stamp = new Date(now).toISOString();
  saveDevices([...loadDevices(), { id, name: deviceName(userAgent), hash: sha256(token), created: stamp, lastSeen: stamp }]);
  return { ok: true, cookie: `${id}.${token}` };
}

/** Whether a device cookie belongs to a paired phone (constant-time on the token's hash). */
export function deviceAllowed(cookie: string | undefined, now = Date.now()): boolean {
  const m = /^([\w-]{8,64})\.([\w-]{20,128})$/.exec(cookie || "");
  if (!m) return false;
  const devices = loadDevices();
  const device = devices.find((d) => d.id === m[1]);
  if (!device) return false;
  const want = Buffer.from(device.hash, "hex");
  const got = Buffer.from(sha256(m[2]), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
  if (now - Date.parse(device.lastSeen || "") > SEEN_EVERY_MS) {
    try {
      saveDevices(devices.map((d) => (d.id === device.id ? { ...d, lastSeen: new Date(now).toISOString() } : d)));
    } catch {
      /* best effort */
    }
  }
  return true;
}

export function listDevices(): Omit<PhoneDevice, "hash">[] {
  return loadDevices().map(({ id, name, created, lastSeen }) => ({ id, name, created, lastSeen }));
}

export function removeDevice(id: string): boolean {
  const devices = loadDevices();
  const left = devices.filter((d) => d.id !== id);
  if (left.length === devices.length) return false;
  saveDevices(left);
  return true;
}

/** For tests: forget pending codes and failures. */
export function resetPairingForTests() {
  state.codes.clear();
  state.failures = { count: 0, since: 0 };
  state.cache = null;
}
