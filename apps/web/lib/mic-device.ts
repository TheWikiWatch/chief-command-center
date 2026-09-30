/**
 * The microphone this device records from (chosen in Check my system). Stored per browser/device; an
 * unplugged choice falls back to the system default because the constraint is only `ideal`.
 */
const KEY = "chief-mic-device";

export function loadMicDevice(): string {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

export function saveMicDevice(id: string) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode */
  }
}

/** getUserMedia audio constraints with the chosen device, keeping the voice-friendly processing. */
export function micConstraints(deviceId = loadMicDevice()): MediaTrackConstraints {
  return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(deviceId ? { deviceId: { ideal: deviceId } } : {}) };
}

export type MicProblem = "denied" | "missing" | "busy" | "unsupported" | "other";

/** What went wrong opening the mic, from the DOMException name. */
export function micProblem(error: unknown): MicProblem {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "missing";
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") return "busy";
  if (name === "TypeError") return "unsupported";
  return "other";
}

/** The last Check my system result on this device, shown in Settings. */
export type VoiceCheckResult = { at: number; mic: "ok" | MicProblem | "silent" | "skipped"; speaker: "heard" | "not-heard" | "failed" | "skipped"; typing: "ok" | "no-speech" | "failed" | "not-set-up" | "skipped" };
const RESULT_KEY = "chief-voice-check";

export function loadVoiceCheck(): VoiceCheckResult | null {
  try {
    const raw = JSON.parse(localStorage.getItem(RESULT_KEY) || "null") as VoiceCheckResult | null;
    return raw && typeof raw.at === "number" ? raw : null;
  } catch {
    return null;
  }
}

export function saveVoiceCheck(result: VoiceCheckResult) {
  try {
    localStorage.setItem(RESULT_KEY, JSON.stringify(result));
  } catch {
    /* private mode */
  }
}
