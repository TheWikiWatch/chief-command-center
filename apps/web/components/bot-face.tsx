"use client";

import { Blobatar } from "@blobatar/react";
import { _layout } from "blobatar";
import { happy, sad, sleepy, thinking } from "blobatar/expression";
import { useEffect, useId, useMemo, useRef } from "react";
import "blobatar/motion.css";

import { readBands, readLevel, isMetering } from "@/lib/audio-level";
import { botIdentity, hashId, type BotIdentity } from "@/lib/bot-identity";
import {
  BUBBLE_BODIES,
  BUBBLE_EYES,
  bodyPath,
  bubblePaint,
  eyePath,
  faceLayout,
  floatHeight,
  GROUND_Y,
  squash,
  strokedEyes,
  type BubbleBody,
  type BubbleEyes,
} from "@/lib/bubble";
import { kickFaceClock, useFaceClock } from "@/lib/face-clock";
import { BLOB_KIND_TRAIT, cn, isBlobShape, parseBlobShape } from "@/lib/faces";
import { CLOSED, mouthPath, mouthStroke, mouthTarget, stepMouth, voiceFromBands, type Mouth, type MouthMood } from "@/lib/mouth";
import { gazeSeed, scanGaze } from "@/lib/eye-scan";
import { lookState, measureLook, stepLook, type Look } from "@/lib/pointer";
import type { FaceLook, Person, Ring } from "@/lib/types";

/** What a face is doing (VISUAL-OVERHAUL §4.2). Defaults from the ring; callers can override. */
export type FaceMood = "idle" | "working" | "failed" | "thinking" | "listening" | "speaking" | "waiting" | "asleep" | "celebrating";

type FaceProps = {
  name: string;
  profileId: string;
  shape?: string;
  color?: string;
  avatarUrl?: string | null;
  ring?: Ring;
  size?: number;
  gazeRef?: (node: SVGSVGElement | HTMLImageElement | null) => void;
  mood?: FaceMood;
  /** Static pose, no animation (small repeated avatars such as the thread gutter). */
  still?: boolean;
  custom?: boolean;
  isChief?: boolean;
  /** A look chosen in the dashboard or by the chief; wins over the Hermes shape and colour. */
  look?: FaceLook | null;
};

/** Props for a person's face in one spread: <BotFace {...faceProps(p)} size={48} />. */
export function faceProps(p: Person) {
  return {
    name: p.name,
    profileId: p.id,
    shape: p.shape,
    color: p.color,
    avatarUrl: p.avatarUrl,
    ring: p.ring,
    custom: p.custom,
    isChief: p.isChief,
    look: p.look,
  };
}

const LOOK_STYLES = new Set(["bubble", "blob", "shape", "photo"]);

/** A saved look the renderers can use, or null (anything malformed falls back to the bot's default face). */
export function usableLook(look: FaceLook | null | undefined): FaceLook | null {
  return look && typeof look === "object" && LOOK_STYLES.has(look.style) ? look : null;
}

function moodFor(ring: Ring, mood?: FaceMood): FaceMood {
  if (mood) return mood;
  return ring === "working" ? "working" : ring === "failed" ? "failed" : "idle";
}

type Pose = {
  tx: number;
  ty: number;
  roll: number;
  scale: number;
  gazeX: number;
  gazeY: number;
  lid: number;
  dots: [number, number, number];
  zz: number;
  /** Eye width multiplier (eyes widen when a face notices you). */
  eyeScale: number;
};

const sin = Math.sin;

/** How much each mood lets the cursor pull its attention (a working bot only glances). */
const LOOK_PULL: Partial<Record<FaceMood, number>> = { working: 0.3, thinking: 0.3, asleep: 0, failed: 0.6, speaking: 0.5, listening: 0.5, celebrating: 0.5 };

/** A face is noticing you: the cursor is on it and it is awake enough to care. */
export function noticing(mood: FaceMood, look?: Look | null) {
  return !!look?.hover && mood !== "asleep";
}

/** The mouth mood: hovering turns a calm face's mouth into a "hello" smile; speech keeps lip-sync. */
export function mouthMood(mood: FaceMood, look?: Look | null): MouthMood {
  if (!noticing(mood, look)) return mood;
  return mood === "idle" || mood === "working" || mood === "thinking" || mood === "waiting" || mood === "listening" ? "notice" : mood;
}

/**
 * Pure pose function: mood + time + personality + live level, then the cursor (PLAN-2026-09-26 §3).
 * Nearby, the eyes and head lean toward the cursor by the attention weight. On hover the face looks
 * straight out at you, widens its eyes and gives a small hop; a sleeping face flutters its eyes open
 * once and goes back to sleep.
 */
export function facePose(mood: FaceMood, t: number, id: BotIdentity, level = 0, look?: Look | null): Pose {
  const pose = moodPose(mood, t, id, level);
  if (!look) return pose;
  if (look.hover && mood === "asleep") {
    const u = look.hoverFor / 1.1;
    if (u < 1) {
      const open = Math.pow(sin(Math.PI * u), 2);
      return { ...pose, lid: 0.3 + open * 1.7, zz: pose.zz * (1 - open), roll: pose.roll * (1 - open * 0.6) };
    }
    return pose;
  }
  const w = look.w * (LOOK_PULL[mood] ?? 1);
  const out = { ...pose };
  if (w > 0.001) {
    out.gazeX += (look.x * 5.2 - out.gazeX) * w;
    out.gazeY += (look.y * 3 - out.gazeY) * w;
    out.tx += look.x * 1.1 * w;
    out.ty += look.y * 0.4 * w;
    out.roll += look.x * 3.5 * w;
  }
  if (noticing(mood, look)) {
    const n = Math.min(1, look.hoverFor / 0.12);
    const hopU = look.hoverFor / 0.32;
    const hop = hopU < 1 ? sin(Math.PI * hopU) : 0;
    out.gazeX *= 1 - n;
    out.gazeY *= 1 - n;
    out.ty -= hop * 2.2;
    out.scale *= 1 + hop * 0.03;
    out.eyeScale = 1 + 0.15 * n;
    if (out.lid > 1) out.lid = out.lid * (1 + 0.12 * n);
  }
  if (look.blink > 0) out.lid = 0.35;
  return out;
}

function moodPose(mood: FaceMood, t: number, id: BotIdentity, level = 0): Pose {
  const p = t + id.phase;
  const breath = sin((p * Math.PI * 2) / id.breathe);
  const blinkT = ((p % id.blink) + id.blink) % id.blink;
  const blinking = blinkT > id.blink - 0.16 || (id.phase > Math.PI && blinkT > 0.3 && blinkT < 0.42);
  const base: Pose = {
    tx: sin(p * 0.42) * 0.35,
    ty: breath * -0.35,
    roll: sin(p * 0.55) * 2.2,
    scale: 1 + breath * 0.018,
    gazeX: sin(p * id.glance * 1.6) * 2.6 + sin(p * 0.11) * 0.7,
    gazeY: sin(p * 0.19) * 1.4,
    lid: blinking ? 0.35 : 2.3,
    dots: [0, 0, 0],
    zz: 0,
    eyeScale: 1,
  };
  switch (mood) {
    case "working":
    case "thinking": {
      // Busy eyes hold and jump (lib/eye-scan.ts): reading along a line while working, up and to one side while
      // thinking. They used to drift on a slow sine and blink every 1.45 s, which read as dazed. The head leans a
      // little toward where the eyes look instead of rocking, and blinks keep the face's own rhythm.
      const rate = mood === "working" ? 2.6 : 2.4;
      const g = scanGaze(mood, t, gazeSeed(id.seed));
      return {
        ...base,
        tx: g.x * 0.7,
        ty: base.ty - 0.3 + g.y * 0.25,
        roll: g.x * (mood === "thinking" ? 5 : 2.5),
        gazeX: g.x * 3.3,
        gazeY: g.y * 2.2,
        lid: blinking ? 0.35 : mood === "working" ? 2.1 : 2.35,
        dots: [0.2 + 0.8 * Math.max(0, sin(t * rate)), 0.2 + 0.8 * Math.max(0, sin(t * rate - 0.7)), 0.2 + 0.8 * Math.max(0, sin(t * rate - 1.4))],
      };
    }
    case "failed":
      return { ...base, tx: 0, ty: 1.2, roll: -4 + sin(t * 0.22) * 0.8, scale: 0.98, gazeX: 0, gazeY: 2.4, lid: t % 4.8 > 4.55 ? 0.35 : 1.7 };
    case "listening":
      return { ...base, ty: -0.8 - level * 1.4, scale: 1.03 + level * 0.07, gazeX: sin(p * 0.3) * 0.8, gazeY: 0.6, lid: blinking ? 0.35 : 2.9, roll: sin(p * 0.8) * 1.4 };
    case "speaking":
      return {
        ...base,
        ty: base.ty - level * 1.3,
        scale: 1 + level * 0.05,
        gazeX: sin(p * 0.35) * 1.2,
        gazeY: 0.3,
        lid: blinking ? 0.35 : Math.max(1.5, 2.4 - level * 0.9),
        roll: sin(p * 1.1) * 2 + level * 2,
      };
    case "waiting":
      return { ...base, tx: 0, ty: -Math.abs(sin(t * 3.1)) * 1.1, gazeX: 0, gazeY: 0.8, lid: blinking ? 0.35 : 2.9, roll: sin(t * 1.6) * 1.5 };
    case "asleep":
      return { ...base, tx: 0, ty: sin((t * Math.PI * 2) / 6) * -0.7 + 0.8, scale: 1 + sin((t * Math.PI * 2) / 6) * 0.03, roll: -7, gazeX: 0, gazeY: 1, lid: 0.3, zz: 0.4 + 0.6 * Math.max(0, sin(t * 1.1)) };
    case "celebrating": {
      const hop = Math.abs(sin(t * 6));
      return { ...base, ty: -hop * 3.2, scale: 1 + (1 - hop) * 0.04, roll: sin(t * 6) * 6, gazeX: 0, gazeY: -1, lid: 1.2 };
    }
    default:
      return base;
  }
}

/** Live level for a mood: your mic while listening, the chief's audio (or a gentle fake) while speaking. */
function liveLevel(mood: FaceMood, t: number) {
  if (mood === "listening") return readLevel("mic");
  if (mood === "speaking") return isMetering("tts") ? readLevel("tts") : 0.35 + 0.35 * Math.max(0, sin(t * 8.5) * sin(t * 3.1));
  return 0;
}

export function BotFace({ name, profileId, shape, color, avatarUrl, ring = "idle", size = 72, gazeRef, mood, still, custom, isChief, look }: FaceProps) {
  const chosen = usableLook(look);
  // A chosen look's colour counts as the bot's own (like Hermes's `custom`); a dark one is lifted to stay visible.
  const lookColor = chosen && chosen.style !== "photo" && chosen.color ? chosen.color : undefined;
  const identity = useMemo(
    () => botIdentity({ id: profileId, name, color: lookColor ?? color, shape, custom: lookColor ? true : custom, isChief }),
    [profileId, name, color, lookColor, shape, custom, isChief],
  );
  const m = moodFor(ring, mood);
  if (chosen?.style === "bubble") return <BubbleFace look={chosen} color={identity.color} size={size} mood={m} identity={identity} still={still} gazeRef={gazeRef} />;
  if (chosen?.style === "shape" && chosen.shape) return <GeometricFace shape={chosen.shape} color={identity.color} size={size} mood={m} identity={identity} still={still} gazeRef={gazeRef} />;
  if (chosen?.style === "blob") {
    const blob = `blobatar:${chosen.seed || identity.seed}:${chosen.blobKind || ""}`;
    return <BlobFace name={name} shape={blob} seed={identity.seed} size={size} mood={m} identity={identity} still={still} gazeRef={gazeRef} />;
  }
  if (avatarUrl) return <PhotoFace name={name} src={avatarUrl} size={size} mood={m} identity={identity} still={still} gazeRef={gazeRef} />;
  if (isBlobShape(identity.shape)) return <BlobFace name={name} shape={identity.shape} seed={identity.seed} size={size} mood={m} identity={identity} still={still} gazeRef={gazeRef} />;
  return <GeometricFace shape={identity.shape} color={identity.color} size={size} mood={m} identity={identity} still={still} gazeRef={gazeRef} />;
}

/**
 * One face's frame loop on the shared clock. Each frame gets the time, where the cursor pulls it, the current mood
 * and the live level (mic or speech) already smoothed, so a face's `draw` needs nothing from this hook's own state.
 */
function useRig(
  el: React.RefObject<Element | null>,
  mood: FaceMood,
  still: boolean | undefined,
  draw: (t: number, look: Look | null, mood: FaceMood, level: number) => void,
) {
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const smoothed = useRef(0);
  const look = useRef(lookState());
  useFaceClock(
    el,
    (t) => {
      const md = moodRef.current;
      smoothed.current += (liveLevel(md, t) - smoothed.current) * 0.35;
      drawRef.current(t, look.current.box || look.current.w > 0.001 ? stepLook(look.current, t) : null, md, smoothed.current);
    },
    !still,
    () => measureLook(look.current, el.current),
  );
  useEffect(() => {
    drawRef.current(0, null, moodRef.current, smoothed.current);
    kickFaceClock();
  }, [mood]);
}

/** Faces smaller than this show no mouth: at avatar-dot sizes it reads as noise. */
const MOUTH_MIN_PX = 24;

/**
 * The mouth's eased shape for one face. Speech reads the chief's live audio bands when a meter runs
 * (fakeVoice otherwise). A redraw that goes back in time (a mood change drawn at t=0) keeps the
 * current shape on animated faces so it still morphs, and snaps on still ones.
 */
function useMouth(identity: BotIdentity, still: boolean | undefined) {
  const state = useRef<{ m: Mouth; last: number }>({ m: CLOSED, last: -1 });
  return (mood: MouthMood, t: number, listen: number): Mouth => {
    const s = state.current;
    if (s.last >= 0 && t < s.last && !still) return s.m;
    const dt = s.last < 0 || t < s.last ? 10 : Math.min(0.1, t - s.last);
    s.last = t;
    const speaking = mood === "speaking";
    const voice = speaking && isMetering("tts") ? voiceFromBands(readLevel("tts"), readBands("tts")) : null;
    s.m = stepMouth(s.m, mouthTarget(mood, t, identity, voice, listen), dt, speaking);
    return s.m;
  };
}

function GeometricFace({
  shape,
  color,
  size,
  mood,
  identity,
  still,
  gazeRef,
}: {
  shape: string;
  color: string;
  size: number;
  mood: FaceMood;
  identity: BotIdentity;
  still?: boolean;
  gazeRef?: (node: SVGSVGElement | null) => void;
}) {
  const uid = useId().replace(/:/g, "");
  const path = useMemo(() => shapePath(shape), [shape]);
  const svg = useRef<SVGSVGElement>(null);
  const body = useRef<SVGGElement>(null);
  const eyeL = useRef<SVGEllipseElement>(null);
  const eyeR = useRef<SVGEllipseElement>(null);
  const glintL = useRef<SVGCircleElement>(null);
  const glintR = useRef<SVGCircleElement>(null);
  const mouth = useRef<SVGPathElement>(null);
  const dots = useRef<SVGGElement>(null);
  const zz = useRef<SVGTextElement>(null);

  const showMouth = size >= MOUTH_MIN_PX;
  const advanceMouth = useMouth(identity, still);
  useRig(svg, mood, still, (t, look, md, level) => {
    const pose = facePose(md, t, identity, level, look);
    body.current?.setAttribute(
      "transform",
      `translate(${pose.tx.toFixed(2)} ${pose.ty.toFixed(2)}) rotate(${pose.roll.toFixed(2)} 20 22) translate(20 22) scale(${pose.scale.toFixed(3)}) translate(-20 -22)`,
    );
    const ey = (17.2 + pose.gazeY * 0.35).toFixed(2);
    const lx = (15.4 + pose.gazeX * 0.22).toFixed(2);
    const rx = (24.6 + pose.gazeX * 0.22).toFixed(2);
    for (const [eye, cx] of [[eyeL.current, lx], [eyeR.current, rx]] as const) {
      eye?.setAttribute("cx", cx);
      eye?.setAttribute("cy", ey);
      eye?.setAttribute("ry", pose.lid.toFixed(2));
      eye?.setAttribute("rx", (2.2 * pose.eyeScale).toFixed(2));
    }
    const glint = pose.lid > 1 ? "1" : "0";
    glintL.current?.setAttribute("cx", (Number(lx) - 0.6).toFixed(2));
    glintR.current?.setAttribute("cx", (Number(rx) - 0.6).toFixed(2));
    glintL.current?.setAttribute("cy", (Number(ey) - 0.7).toFixed(2));
    glintR.current?.setAttribute("cy", (Number(ey) - 0.7).toFixed(2));
    glintL.current?.setAttribute("opacity", glint);
    glintR.current?.setAttribute("opacity", glint);
    if (mouth.current) {
      const m = advanceMouth(mouthMood(md, look), t, md === "listening" ? level : 0);
      mouth.current.setAttribute("d", mouthPath(m, 20 + pose.gazeX * 0.12, 25.4 + pose.gazeY * 0.1, 3.3));
    }
    if (dots.current) {
      const cs = dots.current.children;
      for (let i = 0; i < 3; i++) (cs[i] as SVGElement | undefined)?.setAttribute("opacity", pose.dots[i].toFixed(2));
    }
    zz.current?.setAttribute("opacity", pose.zz.toFixed(2));
  });

  return (
    <svg
      ref={(node) => {
        svg.current = node;
        gazeRef?.(node);
      }}
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 40 44"
      className="overflow-visible"
      style={{ flexShrink: 0 }}
    >
      <defs>
        <linearGradient id={`${uid}-light`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.32" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0.04" />
          <stop offset="1" stopColor="#000" stopOpacity="0.18" />
        </linearGradient>
      </defs>
      <g ref={body}>
        <path d={path} fill={color} />
        <path d={path} fill={`url(#${uid}-light)`} />
        <path d={path} fill="none" stroke="#fff" strokeOpacity="0.22" strokeWidth="0.6" />
        <ellipse ref={eyeL} cx={15.4} cy={17.2} rx={2.2} ry={2.3} fill="rgba(0,0,0,0.85)" />
        <ellipse ref={eyeR} cx={24.6} cy={17.2} rx={2.2} ry={2.3} fill="rgba(0,0,0,0.85)" />
        <circle ref={glintL} cx={14.8} cy={16.5} r={0.65} fill="rgba(255,255,255,0.9)" />
        <circle ref={glintR} cx={24} cy={16.5} r={0.65} fill="rgba(255,255,255,0.9)" />
        {showMouth ? (
          <path
            ref={mouth}
            d={mouthPath(CLOSED, 20, 25.4, 3.3)}
            fill="#000"
            stroke="#000"
            strokeWidth={mouthStroke(1.15, 40, size)}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.8}
          />
        ) : null}
      </g>
      <g ref={dots}>
        <circle cx={16.4} cy={41.4} r={1.15} fill={color} opacity={0} />
        <circle cx={20} cy={41.4} r={1.15} fill={color} opacity={0} />
        <circle cx={23.6} cy={41.4} r={1.15} fill={color} opacity={0} />
      </g>
      <text ref={zz} x={31} y={9} fontSize={7} fontWeight={700} fill={color} opacity={0} fontFamily="system-ui">
        z
      </text>
    </svg>
  );
}

/** A bubble's silhouette and eyes: the chosen ones, or a stable pick from the bot's id when none was chosen. */
export function bubbleParts(look: FaceLook, seed: string): { body: BubbleBody; eyes: BubbleEyes } {
  const h = hashId(`${seed}:bubble`);
  const body = (BUBBLE_BODIES as readonly string[]).includes(look.body || "") ? (look.body as BubbleBody) : BUBBLE_BODIES[h % BUBBLE_BODIES.length];
  const eyes = (BUBBLE_EYES as readonly string[]).includes(look.eyes || "") ? (look.eyes as BubbleEyes) : "dot";
  return { body, eyes };
}

/**
 * The Bubble face (lib/bubble.ts): a soft body lit from the top left, floating over a shadow that shrinks as it rises,
 * with squash and stretch, simple eyes, optional cheeks, the shared mouth and lip-sync, and three thought dots while
 * busy. Every mood pose is the shared `facePose`, so it behaves like every other face.
 */
function BubbleFace({
  look,
  color,
  size,
  mood,
  identity,
  still,
  gazeRef,
}: {
  look: FaceLook;
  color: string;
  size: number;
  mood: FaceMood;
  identity: BotIdentity;
  still?: boolean;
  gazeRef?: (node: SVGSVGElement | null) => void;
}) {
  const uid = useId().replace(/:/g, "");
  const { body, eyes } = bubbleParts(look, identity.seed);
  const d = bodyPath(body);
  const layout = faceLayout(body);
  const paint = bubblePaint(color);
  const line = strokedEyes(eyes);
  const svg = useRef<SVGSVGElement>(null);
  const figure = useRef<SVGGElement>(null);
  const shadow = useRef<SVGEllipseElement>(null);
  const eyeL = useRef<SVGPathElement>(null);
  const eyeR = useRef<SVGPathElement>(null);
  const glintL = useRef<SVGCircleElement>(null);
  const glintR = useRef<SVGCircleElement>(null);
  const mouth = useRef<SVGPathElement>(null);
  const dots = useRef<SVGGElement>(null);
  const zz = useRef<SVGTextElement>(null);

  const showMouth = size >= MOUTH_MIN_PX;
  const advanceMouth = useMouth(identity, still);
  useRig(svg, mood, still, (t, look, md, level) => {
    const pose = facePose(md, t, identity, level, look);
    const breath = Math.sin(((t + identity.phase) * Math.PI * 2) / identity.breathe);
    const lift = still ? 1 : floatHeight(md, t, identity.phase);
    const s = still ? 0 : squash(md, t, breath, level);
    const sx = (1 + s * 0.7) * pose.scale;
    const sy = (1 - s) * pose.scale;
    figure.current?.setAttribute(
      "transform",
      `translate(${pose.tx.toFixed(2)} ${(pose.ty - lift).toFixed(2)}) rotate(${(pose.roll * 0.7).toFixed(2)} 20 ${GROUND_Y - 8}) translate(20 ${GROUND_Y}) scale(${sx.toFixed(3)} ${sy.toFixed(3)}) translate(-20 ${-GROUND_Y})`,
    );
    if (shadow.current) {
      shadow.current.setAttribute("rx", (10.8 * (1 - lift * 0.07) * (1 + s * 0.5)).toFixed(2));
      shadow.current.setAttribute("opacity", Math.max(0.12, 0.5 - lift * 0.07).toFixed(2));
    }
    // A still face is a portrait: eyes open and looking out, never caught mid-blink.
    const gx = still ? 0 : pose.gazeX * 0.24;
    const gy = still ? 0 : pose.gazeY * 0.36;
    const lid = still && md !== "asleep" ? Math.max(pose.lid, 2.3) : pose.lid;
    const shape = eyePath(eyes, lid, pose.eyeScale);
    for (const [eye, glint, [ex, ey]] of [
      [eyeL.current, glintL.current, layout.eyeL],
      [eyeR.current, glintR.current, layout.eyeR],
    ] as const) {
      eye?.setAttribute("d", shape);
      eye?.setAttribute("transform", `translate(${(ex + gx).toFixed(2)} ${(ey + gy).toFixed(2)})`);
      glint?.setAttribute("cx", (ex + gx - 0.7).toFixed(2));
      glint?.setAttribute("cy", (ey + gy - 0.9).toFixed(2));
      glint?.setAttribute("opacity", !line && lid > 1 ? "0.95" : "0");
    }
    if (mouth.current) {
      const m = advanceMouth(mouthMood(md, look), t, md === "listening" ? level : 0);
      mouth.current.setAttribute("d", mouthPath(m, layout.mouth[0] + pose.gazeX * 0.12, layout.mouth[1] + pose.gazeY * 0.1, 3));
    }
    if (dots.current) {
      const cs = dots.current.children;
      for (let i = 0; i < 3; i++) (cs[i] as SVGElement | undefined)?.setAttribute("opacity", pose.dots[i].toFixed(2));
    }
    zz.current?.setAttribute("opacity", pose.zz.toFixed(2));
  });

  const [hx, hy] = layout.highlight;
  return (
    <svg
      ref={(node) => {
        svg.current = node;
        gazeRef?.(node);
      }}
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 40 44"
      className="overflow-visible"
      style={{ flexShrink: 0 }}
    >
      <defs>
        <radialGradient id={`${uid}-body`} cx="0.34" cy="0.24" r="0.88">
          <stop offset="0" stopColor={paint.light} />
          <stop offset="0.46" stopColor={paint.mid} />
          <stop offset="1" stopColor={paint.shade} />
        </radialGradient>
        {/* Ambient occlusion: the underside darkens where the body turns away from the light. */}
        <radialGradient id={`${uid}-ao`} cx="0.5" cy="1.08" r="0.62">
          <stop offset="0" stopColor="#000" stopOpacity="0.32" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${uid}-rim`} cx="0.74" cy="0.94" r="0.62">
          <stop offset="0" stopColor={paint.rim} stopOpacity="0.5" />
          <stop offset="1" stopColor={paint.rim} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${uid}-spec`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#fff" stopOpacity="0.9" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${uid}-shadow`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#000" stopOpacity="0.85" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse ref={shadow} cx={20} cy={GROUND_Y + 3.4} rx={10.8} ry={1.7} fill={`url(#${uid}-shadow)`} opacity={0.5} />
      <g ref={figure}>
        <path d={d} fill={`url(#${uid}-body)`} />
        <path d={d} fill={`url(#${uid}-ao)`} />
        <path d={d} fill={`url(#${uid}-rim)`} />
        <path d={d} fill="none" stroke={paint.rim} strokeOpacity={0.1} strokeWidth={0.4} />
        <ellipse cx={hx} cy={hy} rx={4.6} ry={2.5} transform={`rotate(-28 ${hx} ${hy})`} fill={`url(#${uid}-spec)`} opacity={0.85} />
        <circle cx={hx + 4.4} cy={hy - 0.6} r={0.8} fill="#fff" opacity={0.5} />
        {look.cheeks ? (
          <>
            <ellipse cx={layout.cheekL[0]} cy={layout.cheekL[1]} rx={2.3} ry={1.25} fill={paint.cheek} opacity={0.55} />
            <ellipse cx={layout.cheekR[0]} cy={layout.cheekR[1]} rx={2.3} ry={1.25} fill={paint.cheek} opacity={0.55} />
          </>
        ) : null}
        {[eyeL, eyeR].map((ref, i) => (
          <path
            key={i}
            ref={ref}
            d={eyePath(eyes, 2.3)}
            transform={`translate(${(i ? layout.eyeR : layout.eyeL).join(" ")})`}
            fill={line ? "none" : paint.eye}
            stroke={line ? paint.eye : "none"}
            strokeWidth={line ? 1.15 : 0}
            strokeLinecap="round"
          />
        ))}
        <circle ref={glintL} cx={layout.eyeL[0] - 0.7} cy={layout.eyeL[1] - 0.9} r={0.62} fill="#fff" opacity={line ? 0 : 0.95} />
        <circle ref={glintR} cx={layout.eyeR[0] - 0.7} cy={layout.eyeR[1] - 0.9} r={0.62} fill="#fff" opacity={line ? 0 : 0.95} />
        {showMouth ? (
          <path
            ref={mouth}
            d={mouthPath(CLOSED, layout.mouth[0], layout.mouth[1], 3)}
            fill={paint.eye}
            stroke={paint.eye}
            strokeWidth={mouthStroke(1.05, 40, size)}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.85}
          />
        ) : null}
        {mood === "asleep" ? <path d={d} fill="#000" opacity={0.22} /> : null}
      </g>
      <g ref={dots}>
        <circle cx={30.4} cy={7} r={0.95} fill={paint.light} opacity={0} />
        <circle cx={33.4} cy={4.9} r={1.2} fill={paint.light} opacity={0} />
        <circle cx={36.8} cy={2.6} r={1.5} fill={paint.light} opacity={0} />
      </g>
      <text ref={zz} x={31} y={9} fontSize={7} fontWeight={700} fill={paint.light} opacity={0} fontFamily="system-ui">
        z
      </text>
    </svg>
  );
}

function PhotoFace({
  name,
  src,
  size,
  mood,
  identity,
  still,
  gazeRef,
}: {
  name: string;
  src: string;
  size: number;
  mood: FaceMood;
  identity: BotIdentity;
  still?: boolean;
  gazeRef?: (node: HTMLImageElement | null) => void;
}) {
  const img = useRef<HTMLImageElement>(null);
  useRig(img, mood, still, (t, look, md, level) => {
    const pose = facePose(md, t, identity, level, look);
    if (img.current) img.current.style.transform = `translate(${(pose.tx * 0.4).toFixed(2)}px, ${(pose.ty * 0.6).toFixed(2)}px) rotate(${(pose.roll * 0.4).toFixed(2)}deg) scale(${pose.scale.toFixed(3)})`;
  });
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={(node) => {
        img.current = node;
        gazeRef?.(node);
      }}
      alt={name}
      src={src}
      style={{ width: size, height: size, flexShrink: 0, borderRadius: "22%", objectFit: "cover", display: "block", filter: mood === "asleep" ? "grayscale(0.6)" : undefined }}
    />
  );
}

/**
 * Busy: both eyes level and a little narrowed in focus, still. The library's `thinking` raises one eye and lowers
 * the other and rocks between them, which read as eyes bouncing; where a busy face looks is lib/eye-scan.ts.
 */
const FOCUSED: typeof thinking = {
  ...thinking,
  p: { ...thinking.p, esx: 1.08, esy: 0.8, tilt: 0, edy: 0, edx: 0, esx2: 0, esy2: 0, tilt2: 0, edy2: 0, rock: 0, bdy: -0.3 },
};

function BlobFace({
  name,
  shape,
  seed,
  size,
  mood,
  identity,
  still,
  gazeRef,
}: {
  name: string;
  shape: string;
  seed: string;
  size: number;
  mood: FaceMood;
  identity: BotIdentity;
  still?: boolean;
  gazeRef?: (node: SVGSVGElement | HTMLImageElement | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const parsed = parseBlobShape(shape, seed);
  const traitValue = parsed.kind ? BLOB_KIND_TRAIT[parsed.kind] : undefined;
  const traits = traitValue === undefined ? undefined : { shape: traitValue };
  const expression =
    mood === "working" || mood === "thinking" ? FOCUSED : mood === "failed" ? sad : mood === "asleep" ? sleepy : mood === "celebrating" ? happy : undefined;
  const frame = useMemo(() => blobMouthFrame(parsed.seed, traitValue), [parsed.seed, traitValue]);
  const showMouth = size >= MOUTH_MIN_PX && !!frame;
  const stroke = frame ? mouthStroke(frame.stroke, 100, size).toFixed(2) : "0";
  const advanceMouth = useMouth(identity, still);
  // Animated: the mouth lives inside the Blobatar's own bob group so it breathes and bobs with the
  // head. React replaces that markup when the expression changes, so it is re-attached on demand.
  const injected = useRef<SVGPathElement | null>(null);
  const overlay = useRef<SVGPathElement>(null);
  const mouthNode = () => {
    if (still) return overlay.current;
    if (injected.current?.isConnected) return injected.current;
    const bob = box.current?.querySelector(".mo-bob");
    if (!bob) return null;
    const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
    el.setAttribute("class", "bf-mouth");
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("stroke-linecap", "round");
    bob.appendChild(el);
    injected.current = el;
    return el;
  };
  useRig(box, mood, still, (t, look, md, level) => {
    const pose = facePose(md, t, identity, level, look);
    const k = size / 40;
    if (box.current) box.current.style.transform = `translate(${(pose.tx * k * 0.5).toFixed(2)}px, ${(pose.ty * k * 0.6).toFixed(2)}px) rotate(${(pose.roll * 0.5).toFixed(2)}deg) scale(${pose.scale.toFixed(3)})`;
    if (!showMouth || !frame) return;
    const node = mouthNode();
    if (!node) return;
    const m = advanceMouth(mouthMood(md, look), t, md === "listening" ? level : 0);
    node.setAttribute("d", mouthPath(m, frame.cx, frame.cy, frame.W));
    node.style.strokeWidth = stroke;
  });
  useEffect(() => {
    if (showMouth) return;
    injected.current?.remove();
    injected.current = null;
  }, [showMouth]);
  useEffect(() => () => injected.current?.remove(), []);
  return (
    <div
      ref={box}
      style={{ width: size, height: size, flexShrink: 0, filter: mood === "asleep" ? "saturate(0.5) brightness(0.8)" : undefined }}
      className="relative overflow-visible"
    >
      <Blobatar
        ref={gazeRef as never}
        name={parsed.seed}
        size={size}
        animate={still ? undefined : "always"}
        traits={traits as never}
        expression={expression}
        title={name}
      />
      {still && showMouth && frame ? (
        <svg aria-hidden viewBox="0 0 100 100" width={size} height={size} className="pointer-events-none absolute inset-0">
          <path
            ref={overlay}
            d={mouthPath(CLOSED, frame.cx, frame.cy, frame.W)}
            fill={frame.color}
            stroke={frame.color}
            strokeWidth={stroke}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      ) : null}
    </div>
  );
}

/**
 * Where a Blobatar's mouth goes, from the library's own layout (its face ellipse and eye frames):
 * centred under the eyes, a third of the way from the eyes to the chin, sized from the eye gap and
 * stroked about as thick as an eye is wide. `_layout` is internal, so blobatar is pinned exactly
 * and tests/mouth.test.ts fails loudly if its shape changes.
 */
export function blobMouthFrame(seed: string, shapeTrait?: number) {
  try {
    const layout = _layout(seed, shapeTrait === undefined ? {} : { traits: { shape: shapeTrait } }) as unknown as {
      face: { cx: number; cy: number; ry: number };
      eyes: { cx: number; cy: number; rx: number; ry: number }[];
      palette: { eye: string };
    };
    const [a, b] = layout.eyes;
    if (!a || !b) return null;
    const eyeBottom = Math.max(a.cy + a.ry, b.cy + b.ry);
    const chin = layout.face.cy + layout.face.ry;
    return {
      cx: (a.cx + b.cx) / 2,
      cy: eyeBottom + Math.max(4, chin - eyeBottom) * 0.34,
      W: Math.abs(b.cx - a.cx) * 0.4,
      stroke: ((a.rx + b.rx) / 2) * 0.78,
      color: layout.palette.eye,
    };
  } catch {
    return null;
  }
}

function shapePath(shape: string): string {
  switch (shape) {
    case "squircle":
      return "M8 3 h24 a5 5 0 0 1 5 5 v24 a5 5 0 0 1 -5 5 h-24 a5 5 0 0 1 -5 -5 v-24 a5 5 0 0 1 5 -5 z";
    case "pill":
      return "M8 8 h24 a12 12 0 0 1 0 24 h-24 a12 12 0 0 1 0 -24 z";
    case "triangle":
      return "M20 5.5 L36 33.5 L4 33.5 Z";
    case "hexagon":
      return "M20 3.5 L34.5 11.75 L34.5 28.25 L20 36.5 L5.5 28.25 L5.5 11.75 Z";
    case "cloud":
      return "M11 32 a7.5 7.5 0 0 1 -1 -14.9 A9.5 9.5 0 0 1 29 12.5 A7 7 0 0 1 30 32 Z";
    case "drop":
      return "M20 3 C20 3 6 20 6 27 a14 13.5 0 0 0 28 0 C34 20 20 3 20 3 Z";
    default:
      return "M20 3.5 A16.5 16.5 0 1 1 19.9 3.5 Z";
  }
}

/** The ring around a face; a working ring spins in `color` (the chief's own), or the accent. */
export function FaceRing({ ring, children, className, color }: { ring: Ring; children: React.ReactNode; className?: string; color?: string }) {
  return (
    <div className={cn("relative rounded-full p-[3px]", className)}>
      {ring === "working" ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 animate-spin rounded-full bg-[conic-gradient(from_180deg,var(--ring-color),transparent_55%)] motion-reduce:animate-none"
          style={{ "--ring-color": color || "rgb(var(--c-accent))" } as React.CSSProperties}
        />
      ) : ring === "failed" ? (
        <span aria-hidden className="pointer-events-none absolute inset-0 rounded-full bg-danger/40" />
      ) : null}
      <div className="relative rounded-full bg-canvas p-[2px]">{children}</div>
    </div>
  );
}
