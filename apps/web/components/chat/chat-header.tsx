"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

import { BotFace, FaceRing } from "@/components/bot-face";
import { HeaderStatus, useLinkLabel } from "@/components/connection-status";
import { DeepseekChip } from "@/components/deepseek-chip";
import { AudioLinesIcon, PauseIcon, PlayIcon, SquareIcon } from "@/components/icons";
import { splitTitle } from "@/lib/names";
import { EASE } from "@/lib/motion";
import type { Person } from "@/lib/types";
import { useAssistantName } from "@/lib/identity";

export type ChiefMood = "online" | "thinking" | "preparing" | "speaking" | "paused" | "listening" | "approval" | "offline";

function useSince(active: boolean) {
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setSince(null);
      return;
    }
    setSince(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

/** Chat header (VISUAL-OVERHAUL §5 #3): presence, name, live state line, speech controls, status and settings. */
export function ChatHeader({
  chief,
  mood,
  voiceLabel,
  connected,
  authFailed,
  compact,
  onPauseToggle,
  onStop,
  onOpenStatus,
  onOpenSettings,
  onVoiceMode,
  face,
  status,
}: {
  chief: Person | undefined;
  mood: ChiefMood;
  voiceLabel: string;
  connected: boolean;
  authFailed?: boolean;
  compact?: boolean;
  onPauseToggle: () => void;
  onStop: () => void;
  onOpenStatus?: () => void;
  onOpenSettings?: () => void;
  /** Opens full-screen voice mode (hidden while Chief is speaking, where Pause and Stop take the room). */
  onVoiceMode?: () => void;
  /** Chief's presence renders here when provided (Phase 3); falls back to the plain face. */
  face?: ReactNode;
  /** A status line that wins over the mood's own (e.g. "Has a question for you"). */
  status?: { text: string; tone: string } | null;
}) {
  const thinkingFor = useSince(mood === "thinking");
  const fallbackName = useAssistantName();
  const name = splitTitle(chief?.name).name || fallbackName;
  const speakingish = mood === "speaking" || mood === "paused";
  // On the phone the connection dot stays small; what it would say shows on the status line instead.
  const link = useLinkLabel({ connected, authFailed });
  const linkLine = compact && link.label && (mood === "online" || mood === "offline") ? { text: link.label, tone: link.text } : null;

  const line: { text: string; tone: string } = status ?? linkLine ??
    (mood === "approval"
      ? { text: "Needs your approval", tone: "text-warn" }
      : mood === "listening"
        ? { text: "Listening…", tone: "text-accent-text" }
        : mood === "paused"
          ? { text: "Paused", tone: "text-fg-2" }
          : mood === "preparing"
            ? { text: "Getting voice…", tone: "shimmer-text" }
          : mood === "speaking"
            ? { text: "Speaking…", tone: "text-accent-text" }
            : mood === "thinking"
              ? { text: thinkingFor >= 5 ? `Thinking… ${Math.floor(thinkingFor / 60)}:${String(thinkingFor % 60).padStart(2, "0")}` : "Thinking…", tone: "text-fg-2" }
              : mood === "offline"
                ? { text: "Offline", tone: "text-fg-3" }
                : { text: voiceLabel || "Online", tone: "text-fg-3" });

  return (
    <header className="relative z-20 flex items-center gap-3 border-b border-line px-3 py-2">
      <div className="shrink-0 pl-2 pr-1">
        {face ??
          (chief ? (
            <div className={mood === "thinking" || speakingish ? "await-pulse" : undefined}>
              <FaceRing ring={mood === "thinking" || speakingish ? "working" : chief.ring}>
                <BotFace
                  name={chief.name}
                  profileId={chief.id}
                  shape={chief.shape}
                  color={chief.color}
                  avatarUrl={chief.avatarUrl}
                  ring={mood === "thinking" || speakingish ? "working" : chief.ring}
                  size={38}
                />
              </FaceRing>
            </div>
          ) : null)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="min-w-[2.75rem] truncate text-headline text-fg">{name}</h1>
          {/* DeepSeek's peak/off-peak pricing only matters when the chief runs on DeepSeek. */}
          {chief?.provider === "deepseek" ? <DeepseekChip peakOnly /> : null}
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={line.text.replace(/\d/g, "")}
            className={`flex items-center gap-1.5 truncate text-caption ${line.tone}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.18, ease: EASE.enter } }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}
            aria-live="polite"
          >
            {mood === "speaking" ? <SpeakingBars /> : null}
            <span className="truncate">{line.text}</span>
          </motion.p>
        </AnimatePresence>
      </div>
      <AnimatePresence initial={false}>
        {speakingish || mood === "preparing" ? (
          <motion.div
            key="speech"
            className="flex shrink-0 items-center gap-1"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.12 } }}
          >
            {mood !== "preparing" ? (
            <button
              type="button"
              className="speak-pause-btn press flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-full border border-line-2 bg-white/[0.04] px-2.5 text-callout text-fg-2 hover:text-fg"
              aria-label={mood === "paused" ? "Resume speaking" : "Pause speaking"}
              aria-pressed={mood === "paused"}
              onClick={onPauseToggle}
            >
              {mood === "paused" ? <PlayIcon size={15} /> : <PauseIcon size={15} />}
              {compact ? null : <span>{mood === "paused" ? "Resume" : "Pause"}</span>}
            </button>
            ) : null}
            <button
              type="button"
              className="speak-stop-btn press flex h-10 min-w-10 items-center justify-center gap-1.5 rounded-full border px-2.5 text-callout"
              aria-label="Stop speaking"
              onClick={onStop}
            >
              <SquareIcon size={13} />
              {compact ? null : <span>Stop</span>}
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {onVoiceMode && !speakingish ? (
        <button
          type="button"
          aria-label="Voice mode"
          title="Voice mode"
          className="press grid size-10 shrink-0 place-items-center rounded-full text-fg-2 hover:bg-white/[0.06] hover:text-fg"
          onClick={onVoiceMode}
        >
          <AudioLinesIcon size={19} />
        </button>
      ) : null}
      <HeaderStatus connected={connected} authFailed={authFailed} onOpenStatus={onOpenStatus} onOpenSettings={onOpenSettings} quiet={compact} fullscreen={!compact} />
    </header>
  );
}

function SpeakingBars() {
  return (
    <span className="flex h-3 items-end gap-[2px]" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="speak-bar w-[2px] rounded-full bg-current" style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </span>
  );
}
