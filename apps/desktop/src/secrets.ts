import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The app's own secrets (PLAN §4 "Secrets"), sealed with Electron safeStorage (DPAPI on Windows) in
 * `app\secrets\`. Today that is the bridge token shared by the gateway and the dashboard server; it goes to
 * them through their environment and never to the page. Provider keys stay in Hermes's profile .env, which
 * is Hermes's own credential boundary.
 */
export type Sealer = { isEncryptionAvailable(): boolean; encryptString(s: string): Buffer; decryptString(b: Buffer): string };

export function bridgeToken(dir: string, sealer: Sealer, adopt?: string): string {
  const file = path.join(dir, "bridge-token.bin");
  if (!sealer.isEncryptionAvailable()) throw new Error("Windows can't protect the app's secrets for this user (DPAPI unavailable).");
  if (adopt) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, sealer.encryptString(adopt));
    return adopt;
  }
  if (existsSync(file)) {
    try {
      const token = sealer.decryptString(readFileSync(file));
      if (token.length >= 32) return token;
    } catch {
      // Sealed under a key this app can no longer reach (its Chromium key store was lost or replaced). The
      // gateway and the dashboard both receive the token afresh at every start, so a new one is safe; the
      // unreadable file is kept beside it for diagnosis.
      renameSync(file, path.join(dir, `bridge-token.unreadable-${Date.now()}.bin`));
    }
  }
  const token = randomBytes(32).toString("base64url");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, sealer.encryptString(token));
  return token;
}

/** The read-only key for a private GitHub release repository (Settings → Updates), sealed like the token. "" = none. */
export function readUpdateKey(dir: string, sealer: Sealer): string {
  const file = path.join(dir, "update-key.bin");
  if (!existsSync(file) || !sealer.isEncryptionAvailable()) return "";
  try {
    return sealer.decryptString(readFileSync(file));
  } catch {
    return "";
  }
}

export function saveUpdateKey(dir: string, sealer: Sealer, key: string): void {
  const file = path.join(dir, "update-key.bin");
  const clean = key.trim();
  if (!clean) {
    rmSync(file, { force: true });
    return;
  }
  if (!sealer.isEncryptionAvailable()) throw new Error("Windows can't protect the app's secrets for this user (DPAPI unavailable).");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, sealer.encryptString(clean));
}

