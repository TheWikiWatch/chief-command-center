import { meterElement } from "@/lib/audio-level";
import { logSpeech } from "@/lib/speech-log";
import { assistantName } from "@/lib/identity";

const SPEAK_KEY = "chief-speak-replies";
const FLOOR_KEY = "chief-speak-highwater";
const STAY_KEY = "chief-stay-awake";

const MIME_CANDIDATES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];

export type SpeechResult = "played" | "cancelled" | "failed" | "missed";
export type SpeechSettlement = { status: SpeechResult; reason?: string };
type SpeakSource = string | string[];
type SpeakJob = { parts: Array<() => Promise<SpeakSource>>; epoch: number; settle: (result: SpeechSettlement) => void; queuedAt: number; preview: string };
type SpeakFloorStore = { sessionKey: string; id: number };

export function pickRecorderMime(): string {
  if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
  const safari =
    typeof navigator !== "undefined" &&
    /iP(hone|ad|od)|Safari/i.test(navigator.userAgent) &&
    !/Chrome|CriOS|Android/i.test(navigator.userAgent);
  const ordered = safari
    ? MIME_CANDIDATES
    : ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return ordered.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read recording"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(blob);
  });
}

let audioUnlocked = false;
let ctx: AudioContext | null = null;
let player: HTMLAudioElement | null = null;
let wake: WakeLockSentinel | null = null;
const wakeReasons = new Set<string>();
let wakeWired = false;
const speakQueue: SpeakJob[] = [];
let speaking = false;
let paused = false;
/** True only while sound is actually coming out (a clip is playing and advancing). */
let audible = false;
let epoch = 0;
let playWait: ((result: SpeechSettlement) => void) | null = null;
let revokeCurrent: (() => void) | null = null;
let activeJob: SpeakJob | null = null;
/** Waiters parked while paused between clips; true on resume, false when speech is stopped. */
const resumeWaiters = new Set<(resumed: boolean) => void>();
let mediaSessionWired = false;
const speakingListeners = new Set<() => void>();

function speakingNow() {
  return speaking || paused || speakQueue.length > 0;
}

function emitSpeaking() {
  for (const fn of speakingListeners) fn();
  syncMediaSession();
}

export function currentSpeakEpoch() {
  return epoch;
}

export function getSpeaking() {
  return speakingNow();
}

export function getSpeechPaused() {
  return paused;
}

/**
 * What the speech queue is doing, for the header and Chief's presence: "preparing" while a reply is
 * being turned into audio (no sound yet), "playing" only while sound is coming out.
 */
export type SpeechPhase = "idle" | "preparing" | "playing" | "paused";
export function getSpeechPhase(): SpeechPhase {
  if (paused) return "paused";
  if (!speakingNow()) return "idle";
  return audible ? "playing" : "preparing";
}

export function subscribeSpeaking(onChange: () => void) {
  speakingListeners.add(onChange);
  return () => {
    speakingListeners.delete(onChange);
  };
}

function ensureMediaSession() {
  if (mediaSessionWired || typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  mediaSessionWired = true;
  try {
    navigator.mediaSession.setActionHandler("play", () => {
      void resumeSpeech();
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      pauseSpeech();
    });
    navigator.mediaSession.setActionHandler("stop", () => {
      stopSpeech();
    });
  } catch {
    /* some browsers reject handlers */
  }
}

function syncMediaSession() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  ensureMediaSession();
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: paused ? `${assistantName()} (paused)` : assistantName(),
      artist: "Chief Command Center",
    });
    navigator.mediaSession.playbackState = paused ? "paused" : speakingNow() ? "playing" : "none";
  } catch {
    /* ignore */
  }
}

export async function unlockAudio(): Promise<void> {
  if (audioUnlocked) return;
  try {
    const silent = new Audio(
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=",
    );
    silent.setAttribute("playsinline", "true");
    await silent.play().catch(() => undefined);
  } catch {
    /* ignore */
  }
  try {
    const AC =
      window.AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AC) {
      ctx = ctx || new AC();
      await ctx.resume();
    }
  } catch {
    /* ignore */
  }
  audioUnlocked = true;
}

export async function holdWakeLock(reason = "speech") {
  wireWakeLock();
  wakeReasons.add(reason);
  await ensureWakeLock();
}

export async function releaseWakeLock(reason = "speech") {
  wakeReasons.delete(reason);
  if (wakeReasons.size > 0) return;
  try {
    await wake?.release();
  } catch {
    /* ignore */
  }
  wake = null;
}

function wireWakeLock() {
  if (wakeWired || typeof document === "undefined") return;
  wakeWired = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wakeReasons.size > 0) void ensureWakeLock();
  });
}

async function ensureWakeLock() {
  if (!wakeReasons.size || typeof document === "undefined" || document.visibilityState === "hidden") return;
  if (wake && !wake.released) return;
  try {
    wake = (await navigator.wakeLock?.request("screen")) || null;
    wake?.addEventListener("release", () => {
      wake = null;
      if (wakeReasons.size > 0 && document.visibilityState === "visible") void ensureWakeLock();
    });
  } catch {
    wake = null;
  }
}

export function loadStayAwake(): boolean {
  try {
    return localStorage.getItem(STAY_KEY) === "1";
  } catch {
    return false;
  }
}

export function persistStayAwake(on: boolean) {
  try {
    localStorage.setItem(STAY_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

function releaseClip() {
  const revoke = revokeCurrent;
  revokeCurrent = null;
  revoke?.();
}

/** Hard stop: clear queue, bump epoch, reset position. */
export function stopSpeech() {
  epoch += 1;
  for (const job of speakQueue.splice(0)) job.settle({ status: "cancelled" });
  activeJob?.settle({ status: "cancelled" });
  activeJob = null;
  paused = false;
  releaseClip();
  if (player) {
    player.pause();
    player.removeAttribute("src");
    try {
      player.load();
    } catch {
      /* ignore */
    }
  }
  player = null;
  speaking = false;
  audible = false;
  const done = playWait;
  playWait = null;
  done?.({ status: "cancelled" });
  wakeResumeWaiters(false);
  void releaseWakeLock();
  emitSpeaking();
}

function wakeResumeWaiters(resumed: boolean) {
  const waiters = [...resumeWaiters];
  resumeWaiters.clear();
  for (const fn of waiters) fn(resumed);
}

/** Resolves once speech is resumed (true) or stopped (false); right away when not paused. */
function whenResumed(started: number): Promise<boolean> {
  if (!paused) return Promise.resolve(started === epoch);
  return new Promise(resolve => resumeWaiters.add(resumed => resolve(resumed && started === epoch)));
}

/** Pause in place: the current clip keeps its position, and the next clip waits until Resume. */
export function pauseSpeech() {
  if (paused) return;
  if (!speaking && speakQueue.length === 0) return;
  try {
    player?.pause();
  } catch {
    /* ignore */
  }
  paused = true;
  void releaseWakeLock();
  emitSpeaking();
}

/** Resume from the same position, or let the next clip start if we paused between clips. */
export async function resumeSpeech() {
  if (!paused) return;
  const started = epoch;
  // A clip is mid-play only while playClip is waiting on it; otherwise we paused between clips,
  // and replaying the finished element would repeat what was already said.
  const midClip = !!player && !!playWait;
  try {
    await unlockAudio();
    if (started !== epoch) return;
    await holdWakeLock();
    if (started !== epoch) return;
    if (midClip && player) await player.play();
    if (started !== epoch) return;
    paused = false;
    emitSpeaking();
    wakeResumeWaiters(true);
    if (!speaking) void pumpSpeech();
  } catch {
    /* autoplay / decode */
    emitSpeaking();
  }
}

export function toggleSpeechPause() {
  if (paused) {
    void resumeSpeech();
    return;
  }
  if (speaking || speakQueue.length || (player && !player.paused)) {
    pauseSpeech();
  }
}

export function enqueueSpeech(dataUrl: string, jobEpoch = epoch): Promise<SpeechSettlement> {
  return enqueueSpeechTask(async () => dataUrl, jobEpoch);
}

/** Enqueue before synthesis so slow providers cannot reorder replies. */
export function enqueueSpeechTask(createUrl: () => Promise<SpeakSource>, jobEpoch = epoch): Promise<SpeechSettlement> {
  return enqueueSpeechParts([createUrl], jobEpoch);
}

/**
 * One reply as several parts (PLAN-2026-09-23 §1): part 1 plays while part 2 is prepared, so a long
 * reply starts speaking in about the time a short one would.
 */
export function enqueueSpeechParts(
  parts: Array<() => Promise<SpeakSource>>,
  jobEpoch = epoch,
  preview = "",
): Promise<SpeechSettlement> {
  if (jobEpoch !== epoch) return Promise.resolve({ status: "cancelled" });
  return new Promise(resolve => {
    speakQueue.push({ parts, epoch: jobEpoch, settle: resolve, queuedAt: Date.now(), preview });
    emitSpeaking();
    void pumpSpeech();
  });
}

/** data: URLs fail on phone players. A blob URL is a normal audio source. */
export function playableAudioUrl(source: string): { url: string; revoke: () => void } {
  if (!source.startsWith("data:")) return { url: source, revoke: () => undefined };
  const comma = source.indexOf(",");
  const header = source.slice(5, comma);
  const mime = (header.split(";")[0] || "audio/mpeg").trim() || "audio/mpeg";
  const binary = atob(source.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

/**
 * Let Chief's presence follow his voice (VISUAL-OVERHAUL §4.3). captureStream() only observes the
 * element, so playback is untouched; any failure just leaves the presence on its gentle fallback.
 * The player is reused and a new source replaces the captured track, so each clip is metered anew.
 */
let meteredNow = false;
function meterClip(el: HTMLAudioElement) {
  if (typeof document === "undefined" || document.visibilityState !== "visible") return;
  try {
    meterElement("tts", el);
    meteredNow = true;
  } catch {
    /* metering is decorative */
  }
}

/** Preparing a part may take this long before it counts as failed (it is retried once). */
export const PART_TIMEOUT_MS = 45_000;
/** Sound must start this soon after play(). */
export const START_TIMEOUT_MS = 6_000;
/** Playback that stops advancing this long is a stall. */
export const STALL_MS = 5_000;
/** A reply that could not play while the app was hidden is still spoken on return if it is this recent. */
export const MISSED_AFTER_MS = 120_000;

const hiddenNow = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/** Resolves true when the page is visible again (right away if it is), false if speech was stopped. */
function whenVisible(started: number): Promise<boolean> {
  if (!hiddenNow()) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (value: boolean) => {
      document.removeEventListener("visibilitychange", check);
      clearInterval(timer);
      resolve(value);
    };
    const check = () => {
      if (started !== epoch) finish(false);
      else if (!hiddenNow()) finish(true);
    };
    const timer = setInterval(check, 1000);
    document.addEventListener("visibilitychange", check);
  });
}

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Prepare one part: a slow or failed provider gets one more try before the reply is reported. */
async function preparePart(part: () => Promise<SpeakSource>, started: number): Promise<string[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (started !== epoch) return [];
    try {
      const created = await withTimeout(part(), PART_TIMEOUT_MS, "Voice took too long to prepare");
      const urls = (Array.isArray(created) ? created : [created]).map(url => url.trim()).filter(Boolean);
      if (!urls.length) throw new Error("No audio returned");
      return urls;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Speech unavailable");
}

function setAudible(on: boolean) {
  if (audible === on) return;
  audible = on;
  emitSpeaking();
}

function playClip(source: string, started: number, onSound: () => void): Promise<SpeechSettlement> {
  releaseClip();
  const playable = playableAudioUrl(source);
  revokeCurrent = playable.revoke;
  if (!player) {
    player = new Audio();
    player.setAttribute("playsinline", "true");
  }
  const clip = player;
  clip.src = playable.url;
  return new Promise(resolve => {
    let heard = false;
    let lastTime = -1;
    let stillFor = 0;
    const done = (outcome: SpeechSettlement) => {
      clearTimeout(startTimer);
      clearInterval(stallTimer);
      clip.removeEventListener("playing", markHeard);
      clip.removeEventListener("ended", ended);
      clip.removeEventListener("error", failed);
      if (playWait === done) playWait = null;
      resolve(outcome);
    };
    const startTimer = setTimeout(() => {
      if (!heard && started === epoch && !paused) done({ status: "failed", reason: hiddenNow() ? "App was in the background" : "Playback never started" });
    }, START_TIMEOUT_MS);
    // Stall watchdog: a playing clip whose position stops moving never fires "ended".
    const stallTimer = setInterval(() => {
      if (!heard || paused || started !== epoch) return;
      const now = typeof clip.currentTime === "number" ? clip.currentTime : NaN;
      if (Number.isNaN(now) || clip.ended) return;
      if (clip.paused) {
        // The system paused us (Android backgrounding); resume once the app is visible again.
        if (!hiddenNow()) void clip.play().catch(() => undefined);
        stillFor = 0;
        return;
      }
      if (now === lastTime) {
        stillFor += 1000;
        if (stillFor >= STALL_MS) done({ status: "failed", reason: "Playback stalled" });
      } else {
        stillFor = 0;
        lastTime = now;
        setAudible(true);
      }
    }, 1000);
    const markHeard = () => {
      if (!heard) {
        onSound();
        meterClip(clip);
      }
      heard = true;
      setAudible(true);
    };
    const ended = () => done({ status: "played" });
    const failed = () => {
      if (heard || started !== epoch || !clip.paused) return;
      done({ status: "failed", reason: "Playback never started" });
    };
    playWait = done;
    clip.addEventListener("playing", markHeard);
    clip.addEventListener("ended", ended);
    clip.addEventListener("error", failed);
    void clip.play().catch((err: unknown) => {
      if (heard || started !== epoch || !clip.paused) return;
      const name = err && typeof err === "object" && "name" in err ? String((err as { name?: string }).name) : "";
      if (name === "AbortError" && !clip.paused) return;
      done({ status: "failed", reason: hiddenNow() ? "App was in the background" : "Playback never started" });
    });
  });
}

/** Play one clip. A start failure gets a fresh player; one that happens while hidden waits for you. */
async function playWithRecovery(url: string, started: number, job: SpeakJob, onSound: () => void): Promise<SpeechSettlement> {
  let retries = 1;
  for (;;) {
    const result = await playClip(url, started, onSound);
    if (result.status !== "failed" || started !== epoch) return result;
    if (result.reason === "Playback stalled") return result;
    if (hiddenNow()) {
      const back = await whenVisible(started);
      if (!back || started !== epoch) return { status: "cancelled" };
      if (Date.now() - job.queuedAt > MISSED_AFTER_MS) return { status: "missed", reason: "Missed while away" };
    } else if (retries-- <= 0) {
      return result;
    }
    // Fresh element: some Android players never recover from a failed start.
    player = null;
  }
}

async function pumpSpeech() {
  if (speaking || paused) return;
  const next = speakQueue.shift();
  if (!next) { emitSpeaking(); return; }
  if (next.epoch !== epoch) { next.settle({ status: "cancelled" }); void pumpSpeech(); return; }
  speaking = true;
  activeJob = next;
  paused = false;
  meteredNow = false;
  audible = false;
  emitSpeaking();
  const started = epoch;
  const startedAt = Date.now();
  const wasHidden = hiddenNow();
  let firstSoundMs: number | undefined;
  const onSound = () => {
    if (firstSoundMs === undefined) firstSoundMs = Date.now() - next.queuedAt;
  };
  let result: SpeechSettlement = { status: "cancelled" };
  // Start preparing the first part right away; unlocking audio can happen meanwhile.
  let upcoming = preparePart(next.parts[0], started);
  upcoming.catch(() => undefined);
  try {
    await unlockAudio();
    if (started !== epoch) return;
    await holdWakeLock();
    if (started !== epoch) return;
    let heard = false;
    for (let i = 0; i < next.parts.length; i += 1) {
      // Between parts, only fall back to "preparing" if the next part is actually slow.
      const quiet = i > 0 ? setTimeout(() => setAudible(false), 700) : undefined;
      let urls: string[];
      try {
        urls = await upcoming;
      } finally {
        if (quiet) clearTimeout(quiet);
      }
      if (started !== epoch) return;
      if (i + 1 < next.parts.length) {
        upcoming = preparePart(next.parts[i + 1], started);
        upcoming.catch(() => undefined);
      }
      let stop = false;
      for (const url of urls) {
        if (started !== epoch) return;
        // Paused between clips: hold here instead of starting the next one under a "Paused" label.
        if (!(await whenResumed(started))) return;
        const clip = await playWithRecovery(url, started, next, onSound);
        if (started !== epoch) return;
        if (clip.status === "played") {
          heard = true;
          result = clip;
          continue;
        }
        result =
          heard && clip.status === "failed"
            ? { status: "failed", reason: `Part of this reply did not play (${clip.reason || "error"})` }
            : clip;
        stop = true;
        break;
      }
      if (stop) break;
    }
  } catch (error) {
    result = { status: "failed", reason: error instanceof Error ? error.message : "Speech unavailable" };
  }
  finally {
    releaseClip();
    const settled: SpeechSettlement = started === epoch ? result : { status: "cancelled" };
    next.settle(settled);
    logSpeech({
      at: startedAt,
      preview: next.preview,
      parts: next.parts.length,
      firstSoundMs,
      outcome: settled.status === "failed" && settled.reason === "Playback stalled" ? "stalled" : settled.status,
      reason: settled.reason,
      hidden: wasHidden,
      metered: meteredNow,
    });
    if (epoch === started) {
      activeJob = null;
      speaking = false;
      paused = false;
      audible = false;
      emitSpeaking();
      if (speakQueue.length) void pumpSpeech();
      else void releaseWakeLock();
    }
  }
}

export function loadSpeakEnabled(phone: boolean): boolean {
  try {
    const raw = localStorage.getItem(SPEAK_KEY);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    /* ignore */
  }
  return phone;
}

export function persistSpeakEnabled(on: boolean) {
  try {
    localStorage.setItem(SPEAK_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function loadSpeakHighWater(sessionKey: string): number {
  if (!sessionKey) return 0;
  try {
    const raw = localStorage.getItem(FLOOR_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as SpeakFloorStore;
    if (!parsed || parsed.sessionKey !== sessionKey) return 0;
    return typeof parsed.id === "number" && parsed.id > 0 ? parsed.id : 0;
  } catch {
    return 0;
  }
}

export function persistSpeakHighWater(sessionKey: string, id: number) {
  if (!sessionKey || id <= 0 || id >= 1e12) return;
  try {
    const next = Math.max(loadSpeakHighWater(sessionKey), id);
    localStorage.setItem(FLOOR_KEY, JSON.stringify({ sessionKey, id: next } satisfies SpeakFloorStore));
  } catch {
    /* ignore */
  }
}

/** A file path as it should sound: just the file's name ("E:\Second Brain\wiki\Plan.md" → "Plan"). */
const spokenFile = (path: string) => (path.split(/[\\/]/).pop() || "").replace(/\.[A-Za-z0-9]{1,5}$/, "");

/**
 * Reply text as it should be read aloud: no code, markup, raw URLs or paths. Links keep their words,
 * a bare URL is "link", a path is its file name, and Discord custom emoji codes are dropped.
 */
export function speakableText(content: string) {
  return content
    .replace(/MEDIA:\s*.+?(?=\s+MEDIA:|$)/gi, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/!?\[\[([^\]|#\n]*)(?:#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g, (_, target: string, alias?: string) => alias || spokenFile(target))
    .replace(/<a?:(\w+):\d+>/g, " ")
    .replace(/\bhttps?:\/\/[^\s)>\]]+/gi, "link")
    .replace(/\b[A-Za-z]:[\\/][^\n`"'<>|]*?\.[A-Za-z0-9]{1,5}\b/g, (path) => spokenFile(path))
    .replace(/\b[A-Za-z]:[\\/][^\s`"'<>|]*/g, "a folder")
    .replace(/[#*_~`>|]/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    // A paragraph that already ended in a stop (or was only code) must not add a spoken ". ."
    .replace(/([.!?:])(?:\s+\.)+(?=\s|$)/g, "$1")
    .trim();
}
