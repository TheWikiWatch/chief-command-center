import { requestJson } from "@/lib/request";

/** The on-device speech model for voice typing (bridge contract chief.speech_model.v1). */
export type SpeechModel = { id: string; label: string; bytes: number; installed: boolean; source: string };
export type SpeechJob = { id: string; state: "downloading" | "verifying" | "done" | "cancelled" | "error"; received: number; total: number; error: string };
export type SpeechModelStatus = {
  ok: boolean;
  error?: string;
  default: string;
  models: SpeechModel[];
  job: SpeechJob | null;
  stt: { provider: string; enabled: boolean; local: boolean; ready: boolean };
};

const PREFIX = "/api/bridge/voice/model";
const post = <T>(path: string, body: unknown = {}) =>
  requestJson<T>(`${PREFIX}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, 20_000);

export const speechModel = {
  status: (signal?: AbortSignal) => requestJson<SpeechModelStatus>(PREFIX, { cache: "no-store", signal }, 15_000),
  download: (id: string) => post<{ ok: boolean; error?: string; job?: SpeechJob }>("/download", { id }),
  cancel: () => post<{ ok: boolean }>("/cancel"),
  remove: (id: string) => post<{ ok: boolean; error?: string }>("/delete", { id }),
};

export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
