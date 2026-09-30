import path from "node:path";

import { vaultPath } from "@/lib/server/app-config";
import { bridgeJson } from "@/lib/server/bridge-client";

/**
 * Where the Second Brain is. CHIEF_VAULT_PATH wins (a developer checkout, or an install that sets it);
 * otherwise it is the folder Chief was pointed at in onboarding or Settings (the profile's
 * OBSIDIAN_VAULT_PATH, read through the bridge). Cached briefly; a setup through the app clears the cache.
 */
export type SecondBrainSource = "env" | "chief" | "none";

const TTL_MS = 15_000;
let cache: { at: number; path: string } | null = null;
let inflight: Promise<string> | null = null;

export function invalidateSecondBrain() {
  cache = null;
}

async function fromChief(): Promise<string> {
  try {
    const status = await bridgeJson<{ ok?: boolean; configured?: boolean; path?: string }>("/setup/second-brain", {}, 3000);
    return status.ok && status.configured && status.path ? path.resolve(status.path) : "";
  } catch {
    return cache?.path ?? ""; // gateway down: keep the last answer
  }
}

export async function secondBrain(): Promise<{ path: string; source: SecondBrainSource }> {
  const env = vaultPath();
  if (env) return { path: env, source: "env" };
  if (cache && Date.now() - cache.at < TTL_MS) return { path: cache.path, source: cache.path ? "chief" : "none" };
  inflight ??= fromChief().finally(() => {
    inflight = null;
  });
  const found = await inflight;
  cache = { at: Date.now(), path: found };
  return { path: found, source: found ? "chief" : "none" };
}
