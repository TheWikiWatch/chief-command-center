"use client";

/**
 * Live loudness for the hold-to-talk waveform and Chief's presence (VISUAL-OVERHAUL §4).
 * Analysis never sits in the playback path: the mic stream is only read, and TTS is read
 * through captureStream(), so speech plays exactly as before even if this fails.
 */
export type LevelSource = "mic" | "tts";

type Meter = { analyser: AnalyserNode; buffer: Uint8Array<ArrayBuffer>; stop: () => void };

const meters: Partial<Record<LevelSource, Meter>> = {};
let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    return ctx;
  } catch {
    return null;
  }
}

function attach(source: LevelSource, make: (ac: AudioContext) => AudioNode | null, cleanup?: () => void): () => void {
  detach(source);
  const ac = context();
  if (!ac) return () => undefined;
  try {
    const node = make(ac);
    if (!node) return () => undefined;
    const analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    node.connect(analyser);
    const meter: Meter = {
      analyser,
      buffer: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
      stop: () => {
        try {
          node.disconnect();
        } catch {
          /* already gone */
        }
        cleanup?.();
      },
    };
    meters[source] = meter;
    return () => {
      if (meters[source] === meter) detach(source);
    };
  } catch {
    return () => undefined;
  }
}

export function detach(source: LevelSource) {
  const meter = meters[source];
  if (!meter) return;
  delete meters[source];
  meter.stop();
}

/** Start metering a live microphone stream. Returns a stop function. */
export function meterStream(source: LevelSource, stream: MediaStream): () => void {
  return attach(source, (ac) => ac.createMediaStreamSource(stream));
}

/** Meter an <audio> element without rerouting its output (captureStream). */
export function meterElement(source: LevelSource, el: HTMLMediaElement): () => void {
  const capture = (el as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream;
  if (typeof capture !== "function") return () => undefined;
  return attach(source, (ac) => {
    const stream = capture.call(el);
    if (!stream.getAudioTracks().length) return null;
    return ac.createMediaStreamSource(stream);
  });
}

/** Loudness 0..1 right now (RMS of the waveform, gently expanded). 0 when nothing is metered. */
export function readLevel(source: LevelSource): number {
  const meter = meters[source];
  if (!meter) return 0;
  meter.analyser.getByteTimeDomainData(meter.buffer);
  let sum = 0;
  for (let i = 0; i < meter.buffer.length; i++) {
    const v = (meter.buffer[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / meter.buffer.length);
  return Math.min(1, Math.pow(rms * 3.2, 0.8));
}

let spectrum: Uint8Array<ArrayBuffer> | null = null;
const NO_BANDS = { low: 0, mid: 0, high: 0, sib: 0 };

/**
 * Energy (0..1) in four speech bands for lip-sync: low < 500 Hz, mid 500–2k, high 2–4k, sib 4–8k.
 * All zero when nothing is metered.
 */
export function readBands(source: LevelSource): { low: number; mid: number; high: number; sib: number } {
  const meter = meters[source];
  if (!meter || !ctx) return NO_BANDS;
  const bins = meter.analyser.frequencyBinCount;
  if (!spectrum || spectrum.length !== bins) spectrum = new Uint8Array(new ArrayBuffer(bins));
  meter.analyser.getByteFrequencyData(spectrum);
  const hz = ctx.sampleRate / 2 / bins;
  const band = (lo: number, hi: number) => {
    const a = Math.max(1, Math.floor(lo / hz));
    const b = Math.min(bins - 1, Math.ceil(hi / hz));
    let sum = 0;
    for (let i = a; i <= b; i++) sum += spectrum![i];
    return b >= a ? sum / (b - a + 1) / 255 : 0;
  };
  return { low: band(80, 500), mid: band(500, 2000), high: band(2000, 4000), sib: band(4000, 8000) };
}

/** True only when a meter exists and its audio context is actually running (not suspended). */
export function isMetering(source: LevelSource): boolean {
  return !!meters[source] && ctx?.state === "running";
}
