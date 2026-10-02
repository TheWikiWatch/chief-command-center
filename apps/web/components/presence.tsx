"use client";

import { useRef, useSyncExternalStore, type CSSProperties } from "react";

import { BotFace, faceProps, type FaceMood } from "@/components/bot-face";
import { isMetering, readLevel } from "@/lib/audio-level";
import { chiefColor } from "@/lib/bot-identity";
import { useFaceClock } from "@/lib/face-clock";
import type { Person } from "@/lib/types";
import { getSpeechPhase, subscribeSpeaking } from "@/lib/voice-client";

export type PresenceMood = "online" | "thinking" | "working" | "preparing" | "speaking" | "paused" | "listening" | "approval" | "offline" | "celebrating";

const FACE: Record<PresenceMood, FaceMood> = {
  online: "idle",
  thinking: "thinking",
  working: "working",
  preparing: "idle",
  speaking: "speaking",
  paused: "idle",
  listening: "listening",
  approval: "waiting",
  offline: "asleep",
  celebrating: "celebrating",
};

/**
 * The chief's presence (VISUAL-OVERHAUL §4.3): its face inside an aurora ring, a bloom that swells
 * with its voice, orbiting particles while it thinks, and a voice ring driven by real audio.
 * Speaking is picked up from the speech queue, so every placement reacts without extra wiring.
 */
export function ChiefPresence({
  chief,
  size,
  mood,
  gazeRef,
  className = "",
}: {
  chief: Person;
  size: number;
  mood: PresenceMood;
  gazeRef?: (node: SVGSVGElement | HTMLImageElement | null) => void;
  className?: string;
}) {
  // Speaking follows real sound; while the voice is still being prepared the chief only gets ready.
  const phase = useSyncExternalStore(subscribeSpeaking, getSpeechPhase, () => "idle" as const);
  const effective: PresenceMood =
    mood === "offline" || mood === "approval" || mood === "listening"
      ? mood
      : phase === "paused"
        ? "paused"
        : phase === "playing"
          ? "speaking"
          : phase === "preparing"
            ? "preparing"
            : mood;
  const root = useRef<HTMLDivElement>(null);
  const level = useRef(0);
  const moodRef = useRef(effective);
  moodRef.current = effective;

  // Only the level variable is written per frame; every layer reads it in CSS.
  useFaceClock(
    root,
    (t) => {
      const m = moodRef.current;
      const raw =
        m === "listening"
          ? readLevel("mic")
          : m === "speaking"
            ? isMetering("tts")
              ? readLevel("tts")
              : 0.35 + 0.35 * Math.max(0, Math.sin(t * 8.5) * Math.sin(t * 3.1))
            : 0;
      level.current += (raw - level.current) * 0.3;
      root.current?.style.setProperty("--level", level.current.toFixed(3));
    },
    effective === "speaking" || effective === "listening",
  );

  const color = chiefColor(chief);
  const style = { width: size, height: size, "--s": `${size}px`, "--chief": color } as CSSProperties;

  return (
    <div ref={root} className={`presence ${className}`} data-mood={effective} style={style}>
      <span className="pr-layer pr-bloom" aria-hidden="true" />
      <span className="pr-layer pr-ring" aria-hidden="true" />
      <span className="pr-layer pr-voice" aria-hidden="true" />
      <span className="pr-layer pr-orbit" aria-hidden="true">
        {[0, 72, 144, 216, 288].map((a) => (
          <i key={a} style={{ "--a": `${a}deg` } as CSSProperties} />
        ))}
      </span>
      <span className="pr-layer pr-orbit pr-orbit-tilt" aria-hidden="true">
        {[36, 156, 276].map((a) => (
          <i key={a} style={{ "--a": `${a}deg` } as CSSProperties} />
        ))}
      </span>
      <span className="relative">
        <BotFace {...faceProps(chief)} size={size} mood={FACE[effective]} gazeRef={gazeRef} />
      </span>
    </div>
  );
}
