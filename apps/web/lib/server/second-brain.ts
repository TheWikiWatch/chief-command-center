import path from "node:path";

import { vaultPath } from "@/lib/server/app-config";
import { bridgeJson } from "@/lib/server/bridge-client";

/**
 * Where the Second Brain is. CHIEF_VAULT_PATH wins (a developer checkout, or an install that sets it);
 * otherwise it is the folder Chief was pointed at in onboarding or Settings (the profile's
 * OBSIDIAN_VAULT_PATH, read through the bridge). Cached briefly; a setup through the app clears the cache.
 */
export type SecondBrainSource = "env" | "chief" | "none";

export type SecondBrainFormat = "para" | "wiki";

const TTL_MS = 15_000;
let cache: { at: number; path: string; format: SecondBrainFormat | null } | null = null;
let inflight: Promise<{ path: string; format: SecondBrainFormat | null }> | null = null;

export function invalidateSecondBrain() {
  cache = null;
}

async function fromChief(): Promise<{ path: string; format: SecondBrainFormat | null }> {
  try {
    const status = await bridgeJson<{ ok?: boolean; configured?: boolean; path?: string; format?: string | null }>("/setup/second-brain", {}, 3000);
    const format = status.format === "wiki" || status.format === "para" ? status.format : null;
    return status.ok && status.configured && status.path ? { path: path.resolve(status.path), format } : { path: "", format: null };
  } catch {
    return { path: cache?.path ?? "", format: cache?.format ?? null }; // gateway down: keep the last answer
  }
}

/** The Second Brain's folder and, when Chief set it up, its format (Organized or Agent-first wiki). */
export async function secondBrain(): Promise<{ path: string; source: SecondBrainSource; format: SecondBrainFormat | null }> {
  const env = vaultPath();
  if (env) return { path: env, source: "env", format: null };
  if (cache && Date.now() - cache.at < TTL_MS) return { path: cache.path, source: cache.path ? "chief" : "none", format: cache.format };
  inflight ??= fromChief().finally(() => {
    inflight = null;
  });
  const found = await inflight;
  cache = { at: Date.now(), ...found };
  return { path: found.path, source: found.path ? "chief" : "none", format: found.format };
}
