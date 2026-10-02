/**
 * The environment for this server's Python children (backup engine, learning ledger): the server's own,
 * minus the secrets it holds for itself. Neither child talks to the bridge or the dashboard.
 */
const SECRETS = ["CHIEF_DASHBOARD_TOKEN", "CHIEF_SESSION_SECRET"];

export function childEnv(extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  for (const key of Object.keys(env)) if (SECRETS.includes(key.toUpperCase())) delete env[key];
  return env;
}
