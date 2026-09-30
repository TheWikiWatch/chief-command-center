import path from "node:path";

/**
 * Everything install-specific the web server needs, from its environment. The desktop app sets these
 * for its managed server; a developer sets them in apps/web/.env.local. Nothing here has a personal
 * default: an optional integration that isn't configured is simply off.
 *
 *   CHIEF_OWNER_NAME        how the app addresses its owner (empty: nobody by name)
 *   CHIEF_BRIDGE_URL        the chief gateway's loopback bridge (default http://127.0.0.1:7790)
 *   CHIEF_DASHBOARD_TOKEN   the bridge's bearer token (never sent to the browser)
 *   CHIEF_VAULT_PATH        the Second Brain folder; overrides the one chosen in the app (Settings)
 *   CHIEF_OPS_URL           an Ops-compatible service for Today (optional connector)
 *   CHIEF_LEARNING_DIR      a learning-ledger report folder for Fleet Health (optional connector)
 *   CHIEF_LEARNING_TOOL     the ledger program Fleet Health runs for diffs, reverts and refreshes
 *   CHIEF_HERMES_PYTHON     the Python that runs the ledger
 */
export type AppFeatures = { fleetHealth: boolean; today: boolean; vault: boolean };
export type SecondBrainInfo = { source: "env" | "chief" | "none"; today: "vault" | "ops" | null };
export type PublicAppConfig = { ownerName: string; vaultRoot: string; features: AppFeatures; secondBrain: SecondBrainInfo };

const env = (name: string) => (process.env[name] || "").trim();

export function bridgeUrl(): string {
  return env("CHIEF_BRIDGE_URL") || env("CHIEF_DASHBOARD_BRIDGE_URL") || "http://127.0.0.1:7790";
}

export function opsUrl(): string {
  return env("CHIEF_OPS_URL");
}

export function vaultPath(): string {
  const raw = env("CHIEF_VAULT_PATH");
  return raw ? path.resolve(raw) : "";
}

export type LedgerConfig = { dir: string; tool: string; python: string };

/** The Fleet Health connector, or null when it isn't configured. */
export function ledgerConfig(): LedgerConfig | null {
  const dir = env("CHIEF_LEARNING_DIR");
  if (!dir) return null;
  return {
    dir,
    tool: env("CHIEF_LEARNING_TOOL") || path.join(path.dirname(dir), "tools", "learning", "learning_ledger.py"),
    python: env("CHIEF_HERMES_PYTHON") || "python",
  };
}

/**
 * What the browser may know: names, which features exist, and the vault folder (the vault routes show it
 * anyway; the chat uses it to turn paths into links). No other paths, no URLs, no credentials.
 */
export async function publicAppConfig(): Promise<PublicAppConfig> {
  const { secondBrain } = await import("@/lib/server/second-brain");
  const brain = await secondBrain();
  const ops = !!opsUrl();
  return {
    ownerName: env("CHIEF_OWNER_NAME"),
    vaultRoot: brain.path,
    features: { fleetHealth: !!ledgerConfig(), today: ops || !!brain.path, vault: !!(brain.path || ops) },
    secondBrain: { source: brain.source, today: ops ? "ops" : brain.path ? "vault" : null },
  };
}
