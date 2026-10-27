import { requestJson, sentence } from "@/lib/request";

/*
 * Local models (bridge contract `chief.local_models.v1`, local_ai.py): Hermes's managed llama.cpp runtime. A model
 * runs on this PC's graphics card: free, private, no account. The folder is chosen before the first download.
 */

export type LocalJob = {
  job_id: string;
  kind: "quickstart" | "model-download" | "runtime-install" | "model-activate" | string;
  target: string;
  model_id?: string | null;
  status: "running" | "paused" | "done" | "error";
  phase: string;
  detail: string;
  total_bytes?: number | null;
  done_bytes?: number;
  percent?: number;
  bytes_per_sec?: number | null;
  eta_seconds?: number | null;
  error?: string | null;
  can_pause?: boolean;
  can_resume?: boolean;
};

export type LocalStatus = {
  ok: boolean;
  error?: string;
  enabled: boolean;
  engine: { installed: boolean; backend: string | null; version: string | null; updateAvailable: boolean };
  server: { running: boolean };
  active: string | null;
  loaded: Record<string, string>;
  models: { id: string; size_bytes: number; size_label: string }[];
  machine: { gpu: string | null; vram: string | null; vramBytes: number | null; ramBytes: number | null; sharedMemory: boolean };
  folder: { path: string; chosen: boolean; supported: boolean; suggested: string; freeBytes: number | null; models: number };
  jobs: LocalJob[];
};

export type LocalModel = {
  id: string;
  display_name: string;
  description?: string;
  recommended?: boolean;
  recommended_reason?: string | null;
  downloaded?: boolean;
  downloaded_model_id?: string | null;
  vision?: boolean;
  needs_engine?: boolean;
  fits?: boolean;
  model_id?: string;
  quant?: string;
  size_bytes?: number;
  size_label?: string;
  fit_summary?: string;
  fit_detail?: string;
  spilled?: boolean;
};

type Ok = { ok: boolean; error?: string; job_id?: string | null };
const BASE = "/api/bridge/local-models";
const post = <T extends Ok>(path: string, body: unknown, timeout = 60_000) =>
  requestJson<T>(`${BASE}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeout);

async function must<T extends Ok>(p: Promise<T>, fallback: string): Promise<T> {
  const res = await p;
  if (!res.ok) throw new Error(res.error || fallback);
  return res;
}

export const localModels = {
  status: () => must(requestJson<LocalStatus>(BASE, { cache: "no-store" }, 30_000), "Couldn't read local models"),
  job: (id: string) => must(requestJson<{ ok: boolean; error?: string; job?: LocalJob }>(`${BASE}/job/${encodeURIComponent(id)}`, { cache: "no-store" }, 15_000), "Couldn't read the progress"),
  catalog: () => must(requestJson<{ ok: boolean; error?: string; models: LocalModel[] }>(`${BASE}/catalog`, { cache: "no-store" }, 60_000), "Couldn't read the models"),
  setFolder: (path: string) => must(post<Ok>("folder", { path }), "Couldn't use that folder"),
  quickstart: (model = "") => must(post<Ok>("quickstart", { model }), "Couldn't start the setup"),
  download: (model: string) => must(post<Ok>("download", { model }), "Couldn't start the download"),
  installEngine: () => must(post<Ok>("engine", {}), "Couldn't install the engine"),
  pause: (job: string) => must(post<Ok>("pause", { job }), "Couldn't pause"),
  resume: (job: string) => must(post<Ok>("resume", { job }), "Couldn't resume"),
  remove: (model: string) => must(post<Ok>("remove", { model }), "Couldn't remove the model"),
  /** The chief only: a bot picks a local model from its own model list. */
  activate: (model: string) => must(post<Ok>("activate", { model }), "Couldn't switch to that model"),
  server: (action: "start" | "stop") => must(post<Ok>("server", { action }, 120_000), "Couldn't change the server"),
};

const DOING: Record<string, string> = {
  quickstart: "set up",
  "model-download": "download",
  "runtime-install": "install the engine for",
  "model-activate": "switch to",
};

/** "Couldn't download Qwen X. The disk is full." A failed job in a sentence; Hermes's own words only when they are one. */
export function jobFailure(job: LocalJob): string {
  const what = job.kind === "runtime-install" ? "Couldn't install the local engine." : `Couldn't ${DOING[job.kind] || "finish"} ${job.target}.`;
  const why = sentence(job.error) ? ` ${job.error!.trim().replace(/([^.!?])$/, "$1.")}` : " Check the free space and the internet connection, then try again.";
  return what + why;
}

/** "3.2 GB of 16.5 GB · 42 MB/s · about 6 min left" */
export function progressLine(job: LocalJob): string {
  const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
  const parts: string[] = [];
  if (job.total_bytes) parts.push(`${gb(job.done_bytes || 0)} of ${gb(job.total_bytes)}`);
  if (job.bytes_per_sec) parts.push(`${Math.round(job.bytes_per_sec / 1024 ** 2)} MB/s`);
  if (job.eta_seconds && job.eta_seconds > 0) {
    const m = Math.ceil(job.eta_seconds / 60);
    parts.push(m >= 60 ? `about ${Math.floor(m / 60)} h ${m % 60} min left` : `about ${m} min left`);
  }
  return parts.join(" · ");
}
