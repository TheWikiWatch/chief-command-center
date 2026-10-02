"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, type CSSProperties } from "react";

import type { ChiefMood } from "@/components/chat/chat-header";
import { ChevronDownIcon, PauseIcon, PlayIcon, ShieldAlertIcon, SquareIcon, VolumeXIcon } from "@/components/icons";
import { MicButton, type MicStatus } from "@/components/mic-button";
import { ChiefPresence } from "@/components/presence";
import { botIdentity } from "@/lib/bot-identity";
import { EASE, SPRING } from "@/lib/motion";
import { useLayer } from "@/lib/overlay-stack";
import type { Person } from "@/lib/types";

/**
 * Voice mode (VISUAL-OVERHAUL §4.3, Phase 3b): The chief full screen with one big hold-to-talk button.
 * It reuses the chat's mic, send and speech paths unchanged; this is presentation only.
 */
export function VoiceMode({
  open,
  onClose,
  chief,
  mood,
  micStatus,
  connected,
  busy,
  lastYou,
  lastReply,
  speakOn,
  hint,
  onEnableSpeech,
  onPauseToggle,
  onStop,
  onMicStatus,
  onTranscript,
  onMicError,
  onMicStream,
}: {
  open: boolean;
  onClose: () => void;
  chief: Person | undefined;
  mood: ChiefMood;
  micStatus: MicStatus;
  connected: boolean;
  busy: boolean;
  lastYou: string;
  lastReply: string;
  speakOn: boolean;
  hint: string;
  onEnableSpeech: () => void;
  onPauseToggle: () => void;
  onStop: () => void;
  onMicStatus: (status: MicStatus) => void;
  onTranscript: (text: string) => Promise<void> | void;
  onMicError: (message: string) => void;
  onMicStream: (stream: MediaStream | null) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const recording = micStatus.state === "recording";

  // Android's back gesture and Escape close voice mode instead of leaving the app.
  useLayer(open, () => onCloseRef.current());
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  const color = chief
    ? botIdentity({ id: chief.id, name: chief.name, color: chief.color, shape: chief.shape, custom: chief.custom, isChief: true }).color
    : undefined;
  const speakingish = mood === "speaking" || mood === "paused";
  const state =
    micStatus.state === "transcribing"
      ? "Transcribing…"
      : recording
        ? micStatus.cancelling
          ? "Release to cancel"
          : "Listening…"
        : mood === "approval"
          ? "Needs your approval"
          : mood === "thinking"
            ? "Thinking…"
            : mood === "preparing"
              ? "Getting voice…"
              : mood === "speaking"
              ? "Speaking"
              : mood === "paused"
                ? "Paused"
                : mood === "offline"
                  ? "Offline"
                  : "Hold to talk";

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="voice"
          role="dialog"
          aria-modal="true"
          aria-label="Voice mode"
          className="voice-mode fixed inset-0 z-75 flex flex-col overflow-hidden bg-canvas pb-[max(env(safe-area-inset-bottom),16px)] pt-[max(env(safe-area-inset-top),8px)]"
          style={color ? ({ ["--chief" as string]: color } as CSSProperties) : undefined}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 0.32, ease: EASE.enter } }}
          exit={{ opacity: 0, transition: { duration: 0.2, ease: EASE.exit } }}
        >
          <div aria-hidden className="chat-aurora voice-aurora" data-mood={recording ? "listening" : mood}>
            <span className="au-a" />
            <span className="au-b" />
          </div>

          <div className="relative flex items-center gap-2 px-3">
            <button
              ref={closeRef}
              type="button"
              aria-label="Close voice mode"
              className="press grid size-11 place-items-center rounded-full text-fg-2 hover:bg-white/6 hover:text-fg"
              onClick={onClose}
            >
              <ChevronDownIcon size={22} />
            </button>
            <p className="flex-1 text-center text-callout font-medium text-fg-3">Voice</p>
            <span className="size-11" />
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-7 px-6">
            <motion.div
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: recording ? 1.06 : 1, opacity: 1 }}
              transition={SPRING.gentle}
            >
              {chief ? <ChiefPresence chief={chief} size={168} mood={recording ? "listening" : mood} /> : <div className="size-[168px]" />}
            </motion.div>
            <div className="min-h-7 text-center" aria-live="polite">
              <AnimatePresence mode="wait" initial={false}>
                <motion.p
                  key={state}
                  className={`text-title ${recording && !micStatus.cancelling ? "text-accent-text" : mood === "approval" ? "text-warn" : "text-fg"}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE.enter } }}
                  exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
                >
                  {state}
                </motion.p>
              </AnimatePresence>
            </div>
            <div className="w-full max-w-md space-y-3 text-center">
              {lastYou ? <p className="line-clamp-2 text-callout text-fg-3">“{lastYou}”</p> : null}
              {lastReply ? (
                <p className={`line-clamp-6 text-body transition-colors duration-base ${speakingish ? "text-fg" : "text-fg-2"}`}>{lastReply}</p>
              ) : null}
            </div>
          </div>

          <div className="relative flex flex-col items-center gap-4 px-6 pt-2">
            <div className="flex min-h-10 flex-wrap items-center justify-center gap-2">
              {mood === "approval" ? (
                <button type="button" className="press flex min-h-10 items-center gap-2 rounded-full bg-warn/15 px-4 text-callout font-medium text-warn" onClick={onClose}>
                  <ShieldAlertIcon size={16} /> Review in chat
                </button>
              ) : null}
              {!speakOn ? (
                <button type="button" className="press flex min-h-10 items-center gap-2 rounded-full bg-white/[0.07] px-4 text-callout text-fg-2 hover:text-fg" onClick={onEnableSpeech}>
                  <VolumeXIcon size={16} /> Replies are silent · Turn on
                </button>
              ) : null}
              {hint ? <p role="status" className="text-callout text-warn">{hint}</p> : null}
            </div>
            <div className="grid w-full max-w-xs grid-cols-[1fr_auto_1fr] items-center">
              <div className="flex justify-end pr-5">
                <AnimatePresence initial={false}>
                  {speakingish ? (
                    <motion.button
                      key="pause"
                      type="button"
                      aria-label={mood === "paused" ? "Resume speaking" : "Pause speaking"}
                      className="press grid size-12 place-items-center rounded-full bg-white/[0.07] text-fg-2 hover:text-fg"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      onClick={onPauseToggle}
                    >
                      {mood === "paused" ? <PlayIcon size={18} /> : <PauseIcon size={18} />}
                    </motion.button>
                  ) : null}
                </AnimatePresence>
              </div>
              <MicButton
                large
                disabled={!connected}
                busy={busy}
                onStatus={onMicStatus}
                onTranscript={onTranscript}
                onError={onMicError}
                onStream={onMicStream}
              />
              <div className="flex justify-start pl-5">
                <AnimatePresence initial={false}>
                  {speakingish ? (
                    <motion.button
                      key="stop"
                      type="button"
                      aria-label="Stop speaking"
                      className="press grid size-12 place-items-center rounded-full bg-white/[0.07] text-fg-2 hover:text-fg"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      onClick={onStop}
                    >
                      <SquareIcon size={16} />
                    </motion.button>
                  ) : null}
                </AnimatePresence>
              </div>
            </div>
            <p className="mt-1 text-caption text-fg-3">{recording ? "Slide away to cancel" : "Press and hold, then let go to send"}</p>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
