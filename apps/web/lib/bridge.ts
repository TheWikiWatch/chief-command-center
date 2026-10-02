import type { ApprovalChoice, ExecApproval, Person, Snapshot, Transcript, Peek } from "@/lib/types";
import { requestJson, RequestError } from "@/lib/request";
import { VOICE_FALLBACK_EVENT } from "@/lib/voice-events";
import { currentChatThread } from "@/lib/chat-thread";
export { poll as subscribeBridge } from "@/lib/poll";

const PREFIX = "/api/bridge";
const get = <T>(path: string, signal?: AbortSignal, timeout = 10_000) =>
  requestJson<T>(`${PREFIX}/${path}`, { cache: "no-store", signal }, timeout);
const write = <T>(path: string, body: unknown, timeout = 10_000, method = "POST") =>
  requestJson<T>(`${PREFIX}/${path}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeout);

// The chat's requests carry the thread it shows (lib/chat-thread.ts).
const withThread = <T extends Record<string, unknown>>(body: T): T => {
  const thread = currentChatThread();
  return thread === "main" ? body : { ...body, thread };
};
const threadQuery = () => (currentChatThread() === "main" ? "" : `&thread=${encodeURIComponent(currentChatThread())}`);

export type HealthResult = {
  ok: boolean;
  status: number;
  error?: string;
  voice?: boolean;
  profile?: string;
  /** The bridge's check of the Hermes names it relies on (hermes_api.py); `pending` while it runs. */
  hermes?: HermesCompat;
};

export type HermesCompat = { pending?: boolean; ok?: boolean; missing?: string[]; features?: Record<string, boolean> };

export type VoiceConfig = {
  ok: boolean;
  missing?: boolean;
  stt?: { provider?: string; enabled?: boolean; model?: string };
  tts?: { provider?: string; voice?: string; fallback?: { at: number; reason?: string; voice?: string } };
  error?: string;
};

export type SettingsProvider = {
  id: string;
  name: string;
  status: "ready" | "needs_keys" | "needs_auth" | "needs_setup" | string;
  hint?: string;
  env_key?: string;
  key_url?: string;
};

export type VoiceChoice = { id: string; label: string; group?: string };

export type HermesSettings = {
  ok: boolean;
  source?: string;
  error?: string;
  stt?: {
    provider?: string;
    enabled?: boolean;
    model?: string;
    providers?: SettingsProvider[];
    models?: string[];
  };
  tts?: {
    provider?: string;
    voice?: string;
    providers?: SettingsProvider[];
    voices?: VoiceChoice[];
    /** Set when this engine has a voice picker ("Edge voice", "VoiceStudio voice"). */
    voice_label?: string;
  };
};

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResult> {
  try {
    const data = await get<{ ok: boolean; profile?: string; voice?: boolean }>("health", signal, 4_000);
    return { ...data, ok: data.ok === true && data.profile === "chief", status: 200,
      error: data.profile !== "chief" ? "Bridge is not the chief's gateway" : undefined,
    } as HealthResult;
  } catch (error) {
    return { ok: false, status: error instanceof RequestError ? error.status : 0, error: error instanceof Error ? error.message : "Health failed" };
  }
}

export async function fetchSnapshot(signal?: AbortSignal): Promise<Snapshot> {
  const data = await get<Snapshot>("snapshot", signal, 17_000);
  if (!data.ok || !Array.isArray(data.roster)) throw new Error("Invalid snapshot");
  return data;
}
/**
 * What the chat already knows, for a long-poll: the bridge holds the request (up to `wait` seconds)
 * until a row lands after `after`, generating differs from `gen`, or the approval differs.
 */
export type TranscriptWait = { wait: number; gen: boolean; approval: string; clarify: string; notice: string };

/** `noticeSince`: the newest notice the chat has (epoch seconds), so only newer ones come back. */
export async function fetchTranscript(after = 0, signal?: AbortSignal, live?: TranscriptWait, noticeSince = 0): Promise<Transcript> {
  const q = new URLSearchParams({ after: String(after) });
  const hold = !!(live && after);
  if (hold && live) {
    q.set("wait", String(live.wait));
    q.set("gen", live.gen ? "1" : "0");
    q.set("approval", live.approval);
    q.set("clarify", live.clarify);
    q.set("notice", live.notice);
  }
  if (noticeSince) q.set("nsince", String(noticeSince));
  if (currentChatThread() !== "main") q.set("thread", currentChatThread());
  const data = await get<Transcript>(`transcript?${q}`, signal, hold && live ? (live.wait + 15) * 1000 : 10_000);
  if (!Array.isArray(data.messages) || typeof data.lastId !== "number" || typeof data.sessionKey !== "string") throw new Error("Invalid transcript");
  return data;
}

/** Load earlier: the page of rows before `before` (oldest first), and whether older ones remain. */
export async function fetchEarlier(before: number, signal?: AbortSignal): Promise<Transcript> {
  const data = await get<Transcript>(`transcript?before=${before}${threadQuery()}`, signal, 15_000);
  if (!Array.isArray(data.messages)) throw new Error("Invalid transcript");
  return data;
}
/** One of the thread's earlier conversations (before a fresh start), read-only. */
export async function fetchPreviousConversation(session: string): Promise<Transcript> {
  const data = await get<Transcript>(`transcript?after=0&session=${encodeURIComponent(session)}${threadQuery()}`, undefined, 20_000);
  if (!Array.isArray(data.messages)) throw new Error("That conversation couldn't be read.");
  return data;
}
export const fetchPeek = (id: string) => get<Peek>(`profile/${encodeURIComponent(id)}`);
export async function fetchApprovals(signal?: AbortSignal): Promise<{ ok: boolean; approval: ExecApproval | null }> {
  const data = await get<{ ok: boolean; approval: ExecApproval | null }>(`approvals?x=1${threadQuery()}`, signal);
  if (!data.ok) throw new Error("Approvals unavailable");
  return data;
}
/** Answer the chief's open question: a choice's text, several choices (multi-select), or the owner's own words. */
export const answerQuestion = (id: string, answer: string | string[]) =>
  write<{ ok: boolean; error?: string; code?: string }>("clarify", withThread({ id, answer }));
/** Rename a bot (the chief too): its title, and unless `updateSoul` is false, its SOUL's "You are …". */
export const renameProfile = (profile: string, name: string, role: string, updateSoul = true) =>
  write<{ ok: boolean; error?: string; title?: string; name?: string; role?: string; soul?: string }>(
    "profile/rename",
    { profile, name, role, update_soul: updateSoul },
    20_000,
  );
export const resolveApproval = (requestId: string, choice: ApprovalChoice) =>
  write<{ ok: boolean; resolved?: number; error?: string }>("approve", withThread({ request_id: requestId, choice }));
export type OutboundAttachment = { name: string; mime: string; data_url: string };
/** `clientId` lets the bridge drop a retry of a send that already reached the chief before timing out. */
export const sendToChief = (text: string, attachments: OutboundAttachment[] = [], clientId = "") =>
  write<{ ok: boolean; error?: string; duplicate?: boolean }>("send", withThread({ text, attachments, client_id: clientId }), attachments.length ? 120_000 : 20_000);

export async function fetchVoiceConfig(): Promise<VoiceConfig> {
  try { return await get<VoiceConfig>("voice-config"); }
  catch (error) {
    if (error instanceof RequestError && error.status === 404) return { ok: false, missing: true };
    throw error;
  }
}
export async function fetchSettings(): Promise<HermesSettings> {
  const data = await get<HermesSettings>("settings", undefined, 17_000);
  if (!data.ok) throw new Error(data.error || "Settings unavailable");
  return data;
}
export async function patchSettings(body: {
  stt?: { provider?: string; model?: string; api_key?: string };
  tts?: { provider?: string; voice?: string; api_key?: string };
  secrets?: Record<string, string>;
}): Promise<HermesSettings> {
  const data = await write<HermesSettings>("settings", body, 17_000, "PATCH");
  if (!data.ok) throw new Error(data.error || "Could not save settings");
  return data;
}
/** Stop what the chief is doing now (Hermes's own /stop for this chat). */
export const stopTurn = () => write<{ ok: boolean; error?: string; generating?: boolean }>("stop", withThread({}), 15_000);
/** Queue a message for after the current turn (Hermes's /queue). */
export const queueTurn = (text: string) => write<{ ok: boolean; error?: string }>("queue", withThread({ text }), 15_000);
export const transcribeAudio = (dataUrl: string, mimeType: string) =>
  write<{ ok: boolean; transcript?: string; error?: string; code?: string; filtered?: boolean; no_speech?: boolean }>("transcribe", { data_url: dataUrl, mime_type: mimeType }, 185_000);
export async function speakText(text: string, timeoutMs = 185_000) {
  const res = await write<{ ok: boolean; data_url?: string; data_urls?: string[]; error?: string; fallback?: boolean; fallback_reason?: string }>(
    "speak",
    { text },
    timeoutMs,
  );
  if (res.ok && res.fallback && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(VOICE_FALLBACK_EVENT, { detail: { at: Date.now(), reason: res.fallback_reason || "" } }));
  }
  return res;
}

export function workingPeople(people: Person[]): Person[] {
  return people
    .filter((p) => p.ring === "working" && !p.isChief)
    .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
}
