import { requestJson } from "@/lib/request";

/** The chief's workforce (bridge contract chief.fleet.v1): models, re-pin, retire, restore. */
export type ModelGroup = { provider: string; name: string; kind: string; models: string[] };
export type ModelsResult = { ok: boolean; error?: string; current: { provider: string; model: string }; groups: ModelGroup[] };
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
  retire: (profile: string) => post<FleetResult>("retire", { profile }, 120_000),
  restore: (archiveId: string) => post<FleetResult>("restore", { archive_id: archiveId }, 120_000),
  removeArchive: (archiveId: string) => post<FleetResult>("archive/remove", { archive_id: archiveId }),
};
