import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    const token = sealer.decryptString(readFileSync(file));
    if (token.length >= 32) return token;
  }
  const token = randomBytes(32).toString("base64url");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, sealer.encryptString(token));
  return token;
}
