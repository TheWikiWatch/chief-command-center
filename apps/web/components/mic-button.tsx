"use client";

import { useEffect, useRef, useState } from "react";

import { MicIcon } from "@/components/icons";
import { blobToDataUrl, holdWakeLock, pickRecorderMime, releaseWakeLock, stopSpeech, unlockAudio } from "@/lib/voice-client";

export type MicState = "idle" | "starting" | "recording" | "transcribing";

export type MicStatus = {
  state: MicState;
  cancelling: boolean;
};

export function MicButton({
  disabled,
  busy,
  onTranscript,
  onError,
  onStatus,
  onStream,
  onDrag,
  large,
}: {
  /** Voice mode's big button; the recording logic is identical. */
  large?: boolean;
  disabled?: boolean;
  busy?: boolean;
  onTranscript: (text: string) => Promise<void> | void;
  onError: (message: string) => void;
  onStatus?: (status: MicStatus) => void;
  /** The live microphone stream while recording (null when it stops), for the waveform and Chief's presence. */
  onStream?: (stream: MediaStream | null) => void;
  /** Finger offset from where the hold started, for the slide-to-cancel visual. */
  onDrag?: (dx: number, dy: number) => void;
}) {
  const [state, setState] = useState<MicState>("idle");
  const [cancelling, setCancelling] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const mounted = useRef(true);
  const acquiring = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const cancelled = useRef(false);
  const startPt = useRef<{ x: number; y: number } | null>(null);
  const startedAt = useRef(0);
  const session = useRef(0);
  const transcribeRef = useRef<(blob: Blob, mime: string) => Promise<void>>(async () => undefined);
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const streamCb = useRef(onStream);
  streamCb.current = onStream;
  const dragCb = useRef(onDrag);
  dragCb.current = onDrag;

  function setMic(next: MicState, cancel = false) {
    if (!mounted.current) return;
    setState(next);
    setCancelling(cancel);
    statusRef.current?.({ state: next, cancelling: cancel });
  }

  transcribeRef.current = async (blob: Blob, mime: string) => {
    const id = session.current;
    setMic("transcribing");
    try {
      const { transcribeAudio } = await import("@/lib/bridge");
      const dataUrl = await blobToDataUrl(blob);
      if (!mounted.current || id !== session.current) return;
      const result = await transcribeAudio(dataUrl, mime || blob.type || "audio/webm");
      if (!mounted.current || id !== session.current) return;
      if (!result.ok) {
        onError(result.error || "Could not hear that.");
        return;
      }
      const text = (result.transcript || "").trim();
      if (!text || result.filtered || result.no_speech) {
        onError("No speech detected.");
        return;
      }
      await onTranscript(text);
    } catch (err) {
      if (mounted.current && id === session.current) onError(err instanceof Error ? err.message : "Transcription failed");
    } finally {
      if (id === session.current) setMic("idle");
    }
  };

  function stopTracks() {
    if (streamRef.current) streamCb.current?.(null);
    dragCb.current?.(0, 0);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recRef.current = null;
    void releaseWakeLock();
  }

  /** Start recording. `capture` keeps a pointer hold on this button when the finger slides off it. */
  async function begin(point: { x: number; y: number }, capture?: () => void) {
    if (disabled || busy || acquiring.current || state !== "idle") return;
    acquiring.current = true;
    setMic("starting");
    const id = ++session.current;
    cancelled.current = false;
    startPt.current = point;
    startedAt.current = Date.now();
    capture?.();
    stopSpeech();
    await unlockAudio();
    if (!mounted.current || cancelled.current || session.current !== id) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!mounted.current || cancelled.current || session.current !== id) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      streamRef.current = stream;
      streamCb.current?.(stream);
      const mime = pickRecorderMime();
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (ev) => {
        if (ev.data?.size) chunks.push(ev.data);
      };
      rec.onstop = () => {
        if (!mounted.current || session.current !== id) { stream.getTracks().forEach(t => t.stop()); return; }
        const type = rec.mimeType || mime || "audio/webm";
        const blob = new Blob(chunks, { type });
        stopTracks();
        if (cancelled.current) {
          setMic("idle");
          return;
        }
        if (blob.size < 256 || Date.now() - startedAt.current < 400) {
          setMic("idle");
          onError("Hold the mic to talk");
          return;
        }
        void transcribeRef.current(blob, type);
      };
      recRef.current = rec;
      rec.start();
      if (cancelled.current || session.current !== id) {
        rec.stop();
        stopTracks();
        setMic("idle");
        return;
      }
      acquiring.current = false;
      setMic("recording");
      void holdWakeLock();
    } catch {
      if (session.current !== id || !mounted.current) return;
      acquiring.current = false;
      stopTracks();
      setMic("idle");
      onError("Microphone permission is required.");
    }
  }

  function maybeCancel(e: React.PointerEvent<HTMLButtonElement>) {
    const start = startPt.current;
    if (!start || state !== "recording") return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const away = Math.hypot(dx, dy) > 80;
    cancelled.current = away;
    dragCb.current?.(dx, dy);
    if (away !== cancelling) setMic("recording", away);
  }

  function cancel() {
    cancelled.current = true;
    session.current += 1;
    acquiring.current = false;
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
    stopTracks();
    setMic("idle");
  }

  function end() {
    if (cancelled.current || acquiring.current) { cancel(); return; }
    const rec = recRef.current;
    if (rec && rec.state !== "inactive") rec.stop();
  }

  // Keyboard: hold Space or Enter on the focused button to talk, release to send.
  const keyHeld = useRef(false);
  const holdKey = (e: React.KeyboardEvent) => e.key === " " || e.key === "Enter";

  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => {
    mounted.current = true;
    const onHide = () => {
      if (document.visibilityState === "hidden") cancelRef.current();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onHide);
      cancelRef.current();
    };
  }, []);

  const listening = state === "recording";
  const label = listening
    ? cancelling
      ? "Release to cancel"
      : "Release to send"
    : state === "transcribing"
      ? "Transcribing"
      : state === "starting" ? "Waiting for microphone" : "Hold to talk";

  return (
    <button
      type="button"
      className={`mic-btn relative flex ${large ? "h-20 w-20" : "h-11 w-11"} shrink-0 touch-none select-none items-center justify-center rounded-full transition-[transform,background-color,box-shadow,color] duration-medium ease-enter ${
        listening
          ? cancelling
            ? "mic-rec scale-105 bg-fg-4 text-fg"
            : "mic-rec scale-110 bg-accent text-white shadow-[0_0_0_5px_rgb(var(--c-accent)/0.22),0_0_24px_rgb(var(--c-accent)/0.45)]"
          : state === "starting"
            ? "scale-105 bg-accent/60 text-white"
            : "bg-white/[0.07] text-fg-2 hover:bg-white/[0.1] hover:text-fg active:scale-95"
      }`}
      aria-label={label}
      title={state === "idle" ? "Hold to talk (or hold Space)" : undefined}
      aria-pressed={listening}
      disabled={disabled || busy || state === "transcribing"}
      onPointerDown={(e) => {
        e.preventDefault();
        const target = e.currentTarget;
        const pointerId = e.pointerId;
        void begin({ x: e.clientX, y: e.clientY }, () => target.setPointerCapture?.(pointerId));
      }}
      onPointerMove={maybeCancel}
      onPointerUp={end}
      onPointerCancel={cancel}
      onKeyDown={(e) => {
        if (!holdKey(e)) return;
        e.preventDefault();
        if (e.repeat || keyHeld.current) return;
        keyHeld.current = true;
        void begin({ x: 0, y: 0 });
      }}
      onKeyUp={(e) => {
        if (!holdKey(e) || !keyHeld.current) return;
        e.preventDefault();
        keyHeld.current = false;
        end();
      }}
      onBlur={() => {
        if (!keyHeld.current) return;
        keyHeld.current = false;
        end();
      }}
    >
      {state === "transcribing" ? <span className="mic-spin" aria-hidden="true" /> : <MicIcon size={large ? 30 : 20} strokeWidth={2} />}
    </button>
  );
}
