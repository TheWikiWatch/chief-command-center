"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, FileIcon, FileTextIcon, HardDriveDownloadIcon, PauseIcon, PlayIcon, XIcon } from "@/components/icons";
import { EASE, SPRING } from "@/lib/motion";
import { useLayer } from "@/lib/overlay-stack";
import type { ChatAttachment } from "@/lib/types";

function passthrough(path: string) {
  return /^(https?:|blob:|data:)/i.test(path);
}

export function mediaSrc(path: string) {
  if (passthrough(path)) return path;
  return `/api/bridge/file?path=${encodeURIComponent(path)}`;
}

export function thumbSrc(path: string) {
  if (passthrough(path)) return path;
  return `/api/bridge/thumb?path=${encodeURIComponent(path)}`;
}

export function previewSrc(path: string) {
  if (passthrough(path)) return path;
  return `/api/bridge/preview?path=${encodeURIComponent(path)}`;
}

function duration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const m = Math.floor(seconds / 60);
  return `${m}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

/** Attachments in the thread (VISUAL-OVERHAUL §5 #7). */
export function MessageMedia({ attachments }: { attachments?: ChatAttachment[] }) {
  const [full, setFull] = useState<number | null>(null);
  const group = useId();
  if (!attachments?.length) return null;

  const images = attachments.filter((a) => a.kind === "image");
  const rest = attachments.filter((a) => a.kind !== "image");

  return (
    <>
      {images.length ? (
        <div className={`mt-2 grid gap-1.5 ${images.length > 1 ? "grid-cols-2" : "grid-cols-1"}`}>
          {images.map((a, i) => (
            <motion.button
              key={a.path}
              type="button"
              layoutId={`${group}-${a.path}`}
              onClick={() => setFull(i)}
              className="press overflow-hidden rounded-card border border-line-2 bg-card text-left"
              aria-label={`Open ${a.name}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={mediaSrc(a.path)} alt={a.name} loading="lazy" className="max-h-72 w-full object-cover" />
            </motion.button>
          ))}
        </div>
      ) : null}
      {rest.map((a) => {
        if (a.kind === "video") return <VideoCard key={a.path} a={a} />;
        if (a.kind === "audio") return <AudioCard key={a.path} a={a} />;
        return <FileChip key={a.path} a={a} />;
      })}
      <Lightbox items={images} index={full} group={group} onIndex={setFull} onClose={() => setFull(null)} />
    </>
  );
}

function VideoCard({ a }: { a: ChatAttachment }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [length, setLength] = useState(0);
  const src = mediaSrc(a.path);
  return (
    <div className="mt-2 overflow-hidden rounded-card border border-line-2 bg-canvas">
      <div className="relative">
        <video
          ref={video}
          src={previewSrc(a.path)}
          poster={thumbSrc(a.path)}
          controls={playing}
          playsInline
          preload="metadata"
          className="block max-h-72 w-full bg-black"
          onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
          onPlay={() => setPlaying(true)}
        />
        <AnimatePresence>
          {!playing ? (
            <motion.button
              key="play"
              type="button"
              aria-label={`Play ${a.name}`}
              className="absolute inset-0 flex items-center justify-center bg-linear-to-t from-black/50 via-transparent to-transparent"
              exit={{ opacity: 0, transition: { duration: 0.18 } }}
              onClick={() => {
                setPlaying(true);
                void video.current?.play().catch(() => undefined);
              }}
            >
              <motion.span
                className="glass flex h-14 w-14 items-center justify-center rounded-full text-white"
                whileHover={{ scale: 1.06 }}
                whileTap={{ scale: 0.94 }}
              >
                <PlayIcon size={24} className="translate-x-px fill-current" />
              </motion.span>
              {length ? (
                <span className="absolute bottom-2 right-2 rounded-chip bg-black/60 px-1.5 py-0.5 font-mono text-[11px] tabular text-white">
                  {duration(length)}
                </span>
              ) : null}
            </motion.button>
          ) : null}
        </AnimatePresence>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-caption text-fg-3">
        <span className="truncate">{a.name}</span>
        <a href={src} className="flex shrink-0 items-center gap-1 rounded-chip px-1.5 py-1 text-fg-2 hover:bg-white/6 hover:text-fg">
          <HardDriveDownloadIcon size={14} />
          Full quality
        </a>
      </div>
    </div>
  );
}

function seededBars(seed: string, n: number) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return Array.from({ length: n }, (_, i) => {
    h = Math.imul(h ^ (i + 1), 2246822519) >>> 0;
    return 0.25 + ((h % 1000) / 1000) * 0.75;
  });
}

function AudioCard({ a }: { a: ChatAttachment }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [length, setLength] = useState(0);
  const bars = useMemo(() => seededBars(a.path, 36), [a.path]);
  return (
    <div className="mt-2 flex items-center gap-3 rounded-card border border-line-2 bg-card px-3 py-2.5">
      <audio
        ref={audio}
        src={mediaSrc(a.path)}
        preload="metadata"
        onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
        onTimeUpdate={(e) => setProgress(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
        }}
      />
      <button
        type="button"
        className="press flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-fg text-canvas"
        aria-label={playing ? `Pause ${a.name}` : `Play ${a.name}`}
        onClick={() => {
          const el = audio.current;
          if (!el) return;
          if (el.paused) void el.play().catch(() => undefined);
          else el.pause();
        }}
      >
        {playing ? <PauseIcon size={17} className="fill-current" /> : <PlayIcon size={17} className="translate-x-px fill-current" />}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex h-7 items-center gap-[2px]" aria-hidden="true">
          {bars.map((b, i) => (
            <span
              key={i}
              className={`w-[3px] rounded-full transition-colors duration-fast ${i / bars.length <= progress ? "bg-accent" : "bg-fg-4"}`}
              style={{ height: `${b * 100}%` }}
            />
          ))}
        </div>
        <div className="mt-0.5 flex justify-between text-caption text-fg-3">
          <span className="truncate">{a.name}</span>
          <span className="font-mono tabular">{duration(length)}</span>
        </div>
      </div>
    </div>
  );
}

function FileChip({ a }: { a: ChatAttachment }) {
  const textual = /^(text\/|application\/(pdf|json|msword|vnd))/.test(a.mime || "");
  const Icon = textual ? FileTextIcon : FileIcon;
  const ext = (a.name.split(".").pop() || "").toUpperCase().slice(0, 5);
  return (
    <a
      href={mediaSrc(a.path)}
      download={a.name}
      className="press mt-2 flex items-center gap-3 rounded-card border border-line-2 bg-card px-3 py-2.5 hover:border-line-3"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-ctl bg-white/6 text-fg-2">
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-callout text-fg">{a.name}</span>
        {ext ? <span className="block text-caption text-fg-3">{ext} file</span> : null}
      </span>
      <DownloadIcon size={17} className="shrink-0 text-fg-3" />
    </a>
  );
}

/** Full-screen image. Several images in one message: arrow keys, the side buttons or a sideways swipe move between them. */
function Lightbox({
  items,
  index,
  group,
  onIndex,
  onClose,
}: {
  items: ChatAttachment[];
  index: number | null;
  group: string;
  onIndex: (next: number) => void;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const item = index === null ? null : items[index] ?? null;
  const many = items.length > 1;
  const step = (dir: 1 | -1) => {
    if (index === null || !many) return;
    onIndex((index + dir + items.length) % items.length);
  };
  const stepRef = useRef(step);
  stepRef.current = step;
  useLayer(!!item, onClose);
  useEffect(() => {
    if (!item || !many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") stepRef.current(1);
      if (e.key === "ArrowLeft") stepRef.current(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [item, many]);
  if (!mounted) return null;
  return createPortal(
    <AnimatePresence>
      {item ? (
        <motion.div
          key="lightbox"
          className="fixed inset-0 z-80 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label={item.name}
        >
          <motion.button
            type="button"
            aria-label="Close image"
            className="absolute inset-0 bg-black/90"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.22, ease: EASE.enter } }}
            exit={{ opacity: 0, transition: { duration: 0.16 } }}
            onClick={onClose}
          />
          <motion.div
            layoutId={`${group}-${item.path}`}
            className="relative max-h-full max-w-full overflow-hidden rounded-card"
            transition={SPRING.gentle}
            drag={many ? true : "y"}
            dragDirectionLock
            dragConstraints={{ top: 0, bottom: 0, left: 0, right: 0 }}
            dragElastic={0.7}
            onDragEnd={(_, info) => {
              if (many && Math.abs(info.offset.x) > 80 && Math.abs(info.offset.x) > Math.abs(info.offset.y)) step(info.offset.x < 0 ? 1 : -1);
              else if (Math.abs(info.offset.y) > 120 || Math.abs(info.velocity.y) > 700) onClose();
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={mediaSrc(item.path)} alt={item.name} className="max-h-[88vh] max-w-full object-contain" draggable={false} />
          </motion.div>
          {many ? (
            <>
              <button
                type="button"
                aria-label="Previous image"
                className="glass absolute left-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-fg"
                onClick={() => step(-1)}
              >
                <ChevronLeftIcon size={20} />
              </button>
              <button
                type="button"
                aria-label="Next image"
                className="glass absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full text-fg"
                onClick={() => step(1)}
              >
                <ChevronRightIcon size={20} />
              </button>
              <span className="glass absolute bottom-[calc(env(safe-area-inset-bottom)+20px)] left-1/2 -translate-x-1/2 rounded-full px-3 py-1 font-mono text-caption tabular text-fg-2">
                {(index ?? 0) + 1} / {items.length}
              </span>
            </>
          ) : null}
          <motion.button
            type="button"
            className="glass absolute right-4 top-[calc(env(safe-area-inset-top)+16px)] flex h-11 w-11 items-center justify-center rounded-full text-fg"
            aria-label="Close"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1, transition: SPRING.snappy }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            onClick={onClose}
          >
            <XIcon size={20} />
          </motion.button>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
