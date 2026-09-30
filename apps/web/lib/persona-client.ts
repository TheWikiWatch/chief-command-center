import { requestJson } from "@/lib/request";

/** SOUL and memory of one profile (bridge contract chief.persona.v1). */
export type SoulVersion = { id: string; at: number; size: number; kind: "saved" | "backup" };
export type Soul = { text: string; hash: string; limit: number | null; warnings: string[]; history: SoulVersion[] };
export type MemoryTarget = { entries: string[]; limit: number; used: number; enabled: boolean };
export type Persona = { ok: boolean; profile: string; soul: Soul; memory: MemoryTarget; user: MemoryTarget; error?: string };
export type SoulSave = { ok: boolean; hash?: string; warnings?: string[]; history?: SoulVersion[]; conflict?: boolean; current?: { text: string; hash: string }; error?: string; unchanged?: boolean };
export type MemoryOp = { action: "add"; content: string } | { action: "replace"; entry: string; content: string } | { action: "remove"; entry: string };
export type MemorySave = { ok: boolean; conflict?: boolean; error?: string; memory?: MemoryTarget; user?: MemoryTarget };

const PREFIX = "/api/bridge/persona";
const post = <T>(path: string, body: unknown) =>
  requestJson<T>(`${PREFIX}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 20_000);

export const persona = {
  load: (profile: string) => requestJson<Persona>(`${PREFIX}?profile=${encodeURIComponent(profile)}`, { cache: "no-store" }, 20_000),
  version: (profile: string, id: string) =>
    requestJson<{ ok: boolean; id: string; text: string; error?: string }>(`${PREFIX}/soul/version?profile=${encodeURIComponent(profile)}&id=${encodeURIComponent(id)}`, { cache: "no-store" }),
  saveSoul: (profile: string, text: string, base_hash: string) => post<SoulSave>("/soul", { profile, text, base_hash }),
  restore: (profile: string, id: string, base_hash: string) => post<SoulSave>("/soul/restore", { profile, id, base_hash }),
  editMemory: (profile: string, target: "memory" | "user", ops: MemoryOp[]) => post<MemorySave>("/memory", { profile, target, ops }),
};

/** Hermes stores entries joined by "\n§\n"; this is the size it counts against the limit. */
export const DELIMITER = "\n§\n";
export const memoryUsed = (entries: string[]) => entries.filter((e) => e.trim()).map((e) => e.trim()).join(DELIMITER).length;

/**
 * The editor's rows (each remembering the entry it started from) → Hermes batch operations. Rows with
 * `from` are existing entries (replace when changed, remove when deleted); rows without are additions.
 */
export type MemoryRow = { key: string; from?: string; text: string; deleted?: boolean };

export function memoryOps(rows: MemoryRow[]): MemoryOp[] {
  const ops: MemoryOp[] = [];
  for (const row of rows) {
    const text = row.text.trim();
    if (row.from !== undefined) {
      if (row.deleted || !text) ops.push({ action: "remove", entry: row.from });
      else if (text !== row.from) ops.push({ action: "replace", entry: row.from, content: text });
    } else if (!row.deleted && text) {
      ops.push({ action: "add", content: text });
    }
  }
  return ops;
}
