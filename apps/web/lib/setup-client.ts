import { requestJson } from "@/lib/request";

/** Model provider connection (bridge contract chief.providers.v1). Keys go up once and never come back. */
export type ProviderKind = "key" | "custom" | "external";
export type ProviderRow = {
  slug: string;
  name: string;
  kind: ProviderKind;
  authType: string;
  keyEnv: string;
  connected: boolean;
  current: boolean;
  models: string[];
  featured: string[];
  warning: string;
  /** The key is in the chief's own .env (so the app can remove it), not a sign-in found elsewhere on the PC. */
  keySaved?: boolean;
};
export type SetupStatus = { ready: boolean; provider: string; model: string; error: string };
export type Catalog = { ok: boolean; provider: string; model: string; providers: ProviderRow[]; status: SetupStatus; error?: string };
export type ProviderModels = { ok: boolean; provider: string; models: string[]; featured: string[]; recommended: string; connected: boolean; error?: string };
export type ActionResult = { ok: boolean; error?: string; confirm?: string; code?: string; status?: SetupStatus };
export type EndpointCheck = { ok: boolean; reachable: boolean; error: string; models: string[]; baseUrl: string };
export type TestResult = { ok: boolean; reply?: string; error?: string; code?: string; provider?: string; model?: string };

const PREFIX = "/api/bridge/setup";
const post = <T>(path: string, body: unknown, timeout: number) =>
  requestJson<T>(`${PREFIX}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeout);

export const setup = {
  status: (signal?: AbortSignal) => requestJson<SetupStatus & { ok: boolean }>(`${PREFIX}/status`, { cache: "no-store", signal }, 15_000),
  providers: (refresh = false) => requestJson<Catalog>(`${PREFIX}/providers${refresh ? "?refresh=1" : ""}`, { cache: "no-store" }, 60_000),
  models: (provider: string) => requestJson<ProviderModels>(`${PREFIX}/models?provider=${encodeURIComponent(provider)}`, { cache: "no-store" }, 60_000),
  saveKey: (provider: string, key: string) => post<ActionResult>("key", { provider, key }, 20_000),
  chooseModel: (provider: string, model: string, confirm = false) => post<ActionResult>("model", { provider, model, confirm }, 60_000),
  checkEndpoint: (base_url: string, api_key = "") => post<EndpointCheck>("endpoint/check", { base_url, api_key }, 30_000),
  saveEndpoint: (name: string, base_url: string, model: string, api_key = "", makeDefault = true) =>
    post<ActionResult>("endpoint/save", { name, base_url, model, api_key, make_default: makeDefault }, 30_000),
  /** Forget a provider's key. Refused (code "in_use") for the provider the chief is using. */
  removeKey: (provider: string) => post<ActionResult>("key/remove", { provider }, 20_000),
  test: () => post<TestResult>("test", {}, 60_000),
};

/** Well-known key providers first; the rest alphabetically. The list itself always comes from Hermes. */
const FEATURED = ["openrouter", "anthropic", "openai-api", "gemini", "deepseek", "xai", "mistral", "groq"];

export function sortProviders(rows: ProviderRow[]): { featured: ProviderRow[]; more: ProviderRow[]; external: ProviderRow[] } {
  const keyRows = rows.filter((r) => r.kind === "key");
  const featured = FEATURED.map((slug) => keyRows.find((r) => r.slug === slug)).filter((r): r is ProviderRow => !!r);
  const more = keyRows.filter((r) => !featured.includes(r)).sort((a, b) => a.name.localeCompare(b.name));
  const external = rows.filter((r) => r.kind === "external").sort((a, b) => a.name.localeCompare(b.name));
  return { featured, more, external };
}

/** The Second Brain folder (bridge contract chief.second_brain.v1). */
export type SecondBrainMode = "new" | "keep" | "reorganize";
export type SecondBrainStatus = {
  ok: boolean;
  configured: boolean;
  path: string;
  exists: boolean;
  wiki_path: string;
  mode: SecondBrainMode | null;
  skill_installed: boolean;
  default_path: string;
  error?: string;
};
export type FolderPlan = { folders: string[]; files: string[]; existing: string[] };
export type FolderInspection = {
  ok: boolean;
  error?: string;
  path: string;
  exists: boolean;
  empty: boolean;
  writable: boolean;
  obsidian: boolean;
  ours: boolean;
  notes: number;
  files: number;
  top_folders: string[];
  truncated: boolean;
  choices: SecondBrainMode[];
  plans: Partial<Record<SecondBrainMode, FolderPlan>>;
};
export type SecondBrainResult = { ok: boolean; error?: string; path: string; mode: SecondBrainMode; created: string[]; kept: string[]; next_prompt: string };

export const secondBrain = {
  status: () => requestJson<SecondBrainStatus>(`${PREFIX}/second-brain`, { cache: "no-store" }, 15_000),
  inspect: (path: string) => post<FolderInspection>("second-brain/inspect", { path }, 30_000),
  setUp: (path: string, mode: SecondBrainMode) => post<SecondBrainResult>("second-brain", { path, mode }, 60_000),
  seedSoul: () => post<{ ok: boolean; seeded?: boolean; error?: string }>("soul/seed", {}, 15_000),
};
