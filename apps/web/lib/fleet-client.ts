import { requestJson } from "@/lib/request";

/** The chief's workforce (bridge contract chief.fleet.v1): models, re-pin, retire, restore. */
/** What a model can do, from Hermes's catalog: it reasons (so it takes a thinking level), it has a fast mode, its reasoning can be switched off. */
export type ModelCaps = { reasoning: boolean; fast: boolean; canDisable: boolean };
/** How much of a provider's plan is left: its tightest window (percent left, when it resets), from Hermes's usage cache. */
export type PlanUsage = { left: number; resetsAt: string | null; window: string; accounts?: number };
/** A rate limit Hermes is waiting out: the whole account until a time, or some models. */
export type RateLimit = { scope: "account"; until: string } | { scope: "models"; models: Record<string, string> };
export type ModelGroup = { provider: string; name: string; kind: string; models: string[]; caps?: Record<string, ModelCaps>; usage?: PlanUsage | null; limit?: RateLimit | null };
export type FavoriteModel = { provider: string; model: string };
export type ModelsResult = { ok: boolean; error?: string; current: { provider: string; model: string }; groups: ModelGroup[]; favorites?: FavoriteModel[] };
/** A profile's thinking level for its current model: its own ("" = not set), the profile's general one, and the levels the route takes. */
export type Effort = { ok: boolean; error?: string; provider: string; model: string; effort: string; general: string; levels: string[] };
export type Worker = { id: string; title: string; description: string; model: { provider: string; model: string }; cwd: string; working: boolean };
export type Archive = { id: string; title: string; description: string; retired_at: string; model: { provider: string; model: string } };
export type Roster = { ok: boolean; error?: string; workers: Worker[]; archives: Archive[] };
export type FleetResult = { ok: boolean; error?: string; confirm?: string; archive?: string; title?: string };

const PREFIX = "/api/bridge/fleet";
const post = <T>(path: string, body: unknown, timeout = 60_000) =>
  requestJson<T>(`${PREFIX}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeout);

export const fleetApi = {
  roster: () => requestJson<Roster>(PREFIX, { cache: "no-store" }, 20_000),
  models: (refresh = false) => requestJson<ModelsResult>(`${PREFIX}/models${refresh ? "?refresh=1" : ""}`, { cache: "no-store" }, 60_000),
  setModel: (profile: string, provider: string, model: string, confirm = false) => post<FleetResult>("model", { profile, provider, model, confirm }),
  effort: (profile: string) => requestJson<Effort>(`${PREFIX}/effort?profile=${encodeURIComponent(profile)}`, { cache: "no-store" }, 20_000),
  setEffort: (profile: string, effort: string) => post<Effort>("effort", { profile, effort }),
  favorite: (provider: string, model: string, on: boolean) => post<{ ok: boolean; error?: string; favorites?: FavoriteModel[] }>("favorite", { provider, model, on }),
  retire: (profile: string) => post<FleetResult>("retire", { profile }, 120_000),
  restore: (archiveId: string) => post<FleetResult>("restore", { archive_id: archiveId }, 120_000),
  removeArchive: (archiveId: string) => post<FleetResult>("archive/remove", { archive_id: archiveId }),
};
