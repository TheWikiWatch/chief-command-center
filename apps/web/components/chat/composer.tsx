"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { RecordingBar } from "@/components/chat/recording-bar";
import { EmojiPicker } from "@/components/emoji-picker";
import { ArrowUpIcon, ClockIcon, FileIcon, FilmIcon, ImageIcon, PaperclipIcon, PlusIcon, SmileIcon, SquareIcon, XIcon } from "@/components/icons";
import { MicButton, type MicStatus } from "@/components/mic-button";
import { useAssistantName } from "@/lib/identity";
import { SPRING } from "@/lib/motion";

export type PendingFile = { id: string; name: string; mime: string; previewUrl?: string; file: File };

/**
 * One glass capsule (VISUAL-OVERHAUL §5 #8): + menu, auto-growing field, and a mic that becomes a
 * send arrow once there is something to send. The recording bar takes over while you hold to talk.
 */
export function Composer({
  text,
  onText,
  pendingFiles,
  onAddFiles,
  onRemoveFile,
  connected,
  offline = false,
  busy,
  micStatus,
  onMicStatus,
  onTranscript,
  onMicError,
  onMicStream,
  phone = false,
  working = false,
  answering = false,
  onStop,
  onSendAfter,
}: {
  /** The chief is mid-turn: Enter adds to that work (steer), Stop / Esc ends it, Alt+Enter sends after it. */
  working?: boolean;
  /** The chief asked a question and waits: what you type answers it. */
  answering?: boolean;
  onStop?: () => void;
  onSendAfter?: () => void;
  /** Phone keyboards: Enter adds a line and the arrow sends (desktop: Enter sends, Shift+Enter adds a line). */
  phone?: boolean;
  text: string;
  onText: (next: string) => void;
  pendingFiles: PendingFile[];
  onAddFiles: (list: FileList | null) => void;
  onRemoveFile: (id: string) => void;
  connected: boolean;
  /** Chief is unreachable but messages can still be written: they wait in the outbox. The mic needs him. */
  offline?: boolean;
  busy: boolean;
  micStatus: MicStatus;
  onMicStatus: (status: MicStatus) => void;
  onTranscript: (spoken: string) => Promise<void>;
  onMicError: (message: string) => void;
  onMicStream?: (stream: MediaStream | null) => void;
}) {
  const assistant = useAssistantName();
  const field = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  const [dragX, setDragX] = useState(0);
  const menuBox = useRef<HTMLDivElement>(null);

  const hasContent = !!text.trim() || pendingFiles.length > 0;
  const writable = connected || offline;
  const recording = micStatus.state === "recording";
  const showSend = hasContent && micStatus.state === "idle";

  useEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
    // The placeholder and the buttons beside the box change with the chief's state: measure again then too.
  }, [text, working, answering, connected, offline]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!menuBox.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu]);

  function insertEmoji(emoji: string) {
    const el = field.current;
    if (!el) {
      onText(text + emoji);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    onText(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="relative px-3 pb-2 pt-1">
      <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { onAddFiles(e.target.files); e.target.value = ""; }} />
      <input ref={mediaInput} type="file" multiple accept="image/*,video/*" className="hidden" onChange={(e) => { onAddFiles(e.target.files); e.target.value = ""; }} />

      <AnimatePresence initial={false}>
        {pendingFiles.length ? (
          <motion.div
            className="mb-2 flex gap-2 overflow-x-auto px-1 pb-1 pt-1.5"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto", transition: SPRING.gentle }}
            exit={{ opacity: 0, height: 0, transition: { duration: 0.16 } }}
          >
            <AnimatePresence initial={false}>
              {pendingFiles.map((file) => (
                <motion.div
                  key={file.id}
                  layout
                  className="relative shrink-0"
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1, transition: SPRING.bouncy }}
                  exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.14 } }}
                >
                  {file.previewUrl && file.mime.startsWith("image/") ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={file.previewUrl} alt={file.name} className="h-16 w-16 rounded-card border border-line-2 object-cover" />
                  ) : (
                    <div className="flex h-16 max-w-44 items-center gap-2 rounded-card border border-line-2 bg-card px-3 text-caption text-fg-2">
                      {file.mime.startsWith("video/") ? <FilmIcon size={16} /> : <FileIcon size={16} />}
                      <span className="truncate">{file.name}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    className="press absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-line-2 bg-raised text-fg-2 shadow-e3 hover:text-fg"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => onRemoveFile(file.id)}
                  >
                    <XIcon size={13} strokeWidth={2.25} />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="relative flex items-end gap-2">
        <div className="glass relative flex transition-[border-color] duration-fast focus-within:!border-[rgb(255_255_255/0.26)] min-h-12 min-w-0 flex-1 items-end rounded-[24px] pl-1 pr-1">
          <div ref={menuBox} className="relative shrink-0 self-end pb-1">
            <button
              type="button"
              className={`press flex h-10 w-10 items-center justify-center rounded-full text-fg-2 hover:bg-white/[0.06] hover:text-fg disabled:opacity-40 ${menu ? "bg-white/[0.08] text-fg" : ""}`}
              aria-label="Add attachment or emoji"
              aria-expanded={menu}
              disabled={!writable || busy}
              onClick={() => {
                setPicker(false);
                setMenu((v) => !v);
              }}
            >
              <motion.span animate={{ rotate: menu ? 45 : 0 }} transition={SPRING.snappy} className="flex">
                <PlusIcon size={21} />
              </motion.span>
            </button>
            <AnimatePresence>
              {menu ? (
                <motion.div
                  className="absolute bottom-full left-0 z-30 mb-2 w-56 overflow-hidden rounded-card border border-line-2 bg-raised p-1.5 shadow-e3"
                  initial={{ opacity: 0, y: 8, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING.snappy }}
                  exit={{ opacity: 0, y: 6, scale: 0.97, transition: { duration: 0.12 } }}
                  style={{ originX: 0, originY: 1 }}
                  role="menu"
                >
                  {[
                    { label: "Attach files", Icon: PaperclipIcon, run: () => fileInput.current?.click() },
                    { label: "Photo or video", Icon: ImageIcon, run: () => mediaInput.current?.click() },
                    { label: "Insert emoji", Icon: SmileIcon, run: () => setPicker(true) },
                  ].map(({ label, Icon, run }, i) => (
                    <motion.button
                      key={label}
                      type="button"
                      role="menuitem"
                      aria-label={label}
                      className="flex min-h-11 w-full items-center gap-3 rounded-ctl px-3 text-body text-fg hover:bg-white/[0.06]"
                      initial={{ opacity: 0, x: -6 }}
                      animate={{ opacity: 1, x: 0, transition: { delay: i * 0.03, duration: 0.18 } }}
                      onClick={() => {
                        setMenu(false);
                        run();
                      }}
                    >
                      <Icon size={18} className="text-fg-2" />
                      {label}
                    </motion.button>
                  ))}
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
          <textarea
            ref={field}
            value={text}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={(e) => {
              // Enter while an input method is composing (accents, predictive text) only confirms it.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Escape" && working && onStop) {
                e.preventDefault();
                onStop();
                return;
              }
              if (e.key === "Enter" && e.altKey && working && !answering && onSendAfter && text.trim() && !pendingFiles.length) {
                e.preventDefault();
                onSendAfter();
                return;
              }
              if (e.key !== "Enter" || e.shiftKey) return;
              if (phone && !(e.ctrlKey || e.metaKey)) return;
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }}
            onPaste={(e) => {
              // A pasted screenshot or copied file becomes an attachment; pasted text stays text.
              const files = e.clipboardData?.files;
              if (!files?.length || !writable || busy) return;
              if (!e.clipboardData.getData("text/plain")) e.preventDefault();
              onAddFiles(files);
            }}
            enterKeyHint={phone ? "enter" : "send"}
            placeholder={
              connected
                ? answering
                  ? phone
                    ? `Answer ${assistant}…`
                    : `Answer ${assistant} in your own words…`
                  : working
                    ? `Add to what ${assistant} is doing…`
                    : `Message ${assistant}`
                : offline
                  ? `${assistant} is offline · it will wait`
                  : "Gateway down"
            }
            disabled={!writable || busy}
            rows={1}
            className="max-h-[168px] min-w-0 flex-1 resize-none bg-transparent px-1.5 py-3 leading-6 text-fg outline-none focus-visible:outline-none placeholder:text-fg-3 disabled:opacity-60"
          />
        </div>

        <AnimatePresence initial={false}>
          {working && !answering && connected && onSendAfter && hasContent && !pendingFiles.length ? (
            <motion.button
              key="after"
              type="button"
              aria-label={`Send after ${assistant} finishes`}
              title={`Send after ${assistant} finishes (Alt+Enter)`}
              onClick={onSendAfter}
              className="press flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-full border border-line-2 text-fg-2 hover:text-fg"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1, transition: SPRING.snappy }}
              exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.12 } }}
            >
              <ClockIcon size={18} />
            </motion.button>
          ) : null}
          {working && connected && onStop ? (
            <motion.button
              key="stop"
              type="button"
              aria-label={`Stop ${assistant}`}
              title={`Stop ${assistant} (Esc)`}
              onClick={onStop}
              className="press flex h-11 w-11 shrink-0 items-center justify-center self-center rounded-full border border-line-2 bg-raised text-fg hover:border-line-3"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1, transition: SPRING.snappy }}
              exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.12 } }}
            >
              <SquareIcon size={14} fill="currentColor" />
            </motion.button>
          ) : null}
        </AnimatePresence>

        <div className="relative flex h-12 w-12 shrink-0 items-center justify-center">
          <AnimatePresence initial={false} mode="popLayout">
            {showSend ? (
              <motion.button
                key="send"
                type="submit"
                aria-label={connected ? (answering ? "Send answer" : working ? `Add to ${assistant}'s current work` : "Send") : `Queue for ${assistant}`}
                title={connected && answering ? "Send answer" : connected && working ? `Add to ${assistant}'s current work (Enter)` : undefined}
                disabled={!writable || busy}
                className="press flex h-11 w-11 items-center justify-center rounded-full bg-accent-solid text-white shadow-[0_4px_18px_rgb(var(--c-accent)/0.35)] disabled:opacity-40"
                initial={{ opacity: 0, scale: 0.6, rotate: -90 }}
                animate={{ opacity: 1, scale: 1, rotate: 0, transition: SPRING.snappy }}
                exit={{ opacity: 0, scale: 0.6, rotate: 90, transition: { duration: 0.12 } }}
              >
                <ArrowUpIcon size={20} strokeWidth={2.4} />
              </motion.button>
            ) : (
              <motion.span
                key="mic"
                className="flex"
                initial={{ opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1, transition: SPRING.snappy }}
                exit={{ opacity: 0, scale: 0.6, transition: { duration: 0.12 } }}
              >
                <MicButton
                  disabled={!connected}
                  busy={busy}
                  onStatus={(status) => {
                    onMicStatus(status);
                    if (status.state !== "recording") setDragX(0);
                  }}
                  onTranscript={onTranscript}
                  onError={onMicError}
                  onStream={onMicStream}
                  onDrag={(dx) => setDragX(dx)}
                />
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        <AnimatePresence>{recording ? <RecordingBar key="rec" cancelling={micStatus.cancelling} dragX={dragX} /> : null}</AnimatePresence>
      </div>

      {picker ? (
        <div className="absolute bottom-full left-3 z-30 mb-1">
          <EmojiPicker onPick={insertEmoji} onClose={() => setPicker(false)} />
        </div>
      ) : null}
    </div>
  );
}
