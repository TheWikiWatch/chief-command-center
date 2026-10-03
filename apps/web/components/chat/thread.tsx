"use client";

import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Streamdown } from "streamdown";

import { BotFace, faceProps } from "@/components/bot-face";
import { ChiefPresence } from "@/components/presence";
import { EmojiText } from "@/components/emoji-text";
import {
  ArrowDownIcon,
  BotIcon,
  Volume2Icon,
  CheckIcon,
  CopyIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  ListChecksIcon,
  ShieldAlertIcon,
  SparklesIcon,
  WrenchIcon,
  type IconProps,
} from "@/components/icons";
import { MessageMedia } from "@/components/message-media";
import { StickState } from "@/lib/stick-to-bottom";
import { linkifyVaultRefs, openInVault, parseVaultHref } from "@/lib/vault-client";
import { chatTone, isMachineNote, notePreview, type ChatTone } from "@/lib/chat-tone";
import { plainCustomEmoji } from "@/lib/emoji";
import { EASE, SPRING } from "@/lib/motion";
import { messageTimeMs, uniqueToolNames } from "@/lib/thinking-chrome";
import { looksFailed, stepDuration, toolLabel } from "@/lib/tool-labels";
import { Tip } from "@/components/ui/popovers";
import { readAloud } from "@/components/chat/use-reply-speech";
import type { ChatMessage, ChatNotice, PendingQuestion, Person, TurnActivity } from "@/lib/types";
import { AskedRow, NoticeBody, QuestionCard } from "@/components/chat/question";
import { useAssistantName } from "@/lib/identity";

const OPTIMISTIC = 1e12;

function toBottom(el: HTMLElement, smooth: boolean) {
  if (typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  else el.scrollTop = el.scrollHeight;
}

type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "msg"; key: string; m: ChatMessage; first: boolean; last: boolean; mine: boolean }
  | { kind: "tools"; key: string; items: ChatMessage[] };

function dayLabel(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function clock(ms: number) {
  return Number.isFinite(ms) ? new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
}

function stripMediaTags(content: string) {
  return content.replace(/MEDIA:\s*.+?(?=\s+MEDIA:|$)/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

const isToolOnly = (m: ChatMessage) => chatTone(m) === "tool" && !m.attachments?.length;

/**
 * Notices (scheduled-job results, gateway notices) in time order among the messages. They get ids below
 * zero so they never count as transcript rows; messages without a time (just sent) stay last.
 */
// The message a notice is shown as, kept per notice so it stays the same object from one update to the next
// (rows built from it can then skip re-rendering).
const noticeMessages = new WeakMap<ChatNotice, ChatMessage>();

function noticeId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return -(Math.abs(h) % 1_000_000_000) - 1;
}

export function withNotices(messages: ChatMessage[], notices: ChatNotice[] | undefined): ChatMessage[] {
  if (!notices?.length) return messages;
  const items: ChatMessage[] = notices.map((n) => {
    let item = noticeMessages.get(n);
    if (!item) {
      item = { id: noticeId(n.id), role: "assistant", content: "", timestamp: String(n.at), notice: n };
      noticeMessages.set(n, item);
    }
    return item;
  });
  const out: ChatMessage[] = [];
  let next = 0;
  for (const m of messages) {
    const ms = m.id >= OPTIMISTIC ? Number.POSITIVE_INFINITY : messageTimeMs(m.timestamp);
    while (next < items.length && Number.isFinite(ms) && items[next].notice!.at * 1000 <= ms) out.push(items[next++]);
    out.push(m);
  }
  while (next < items.length) out.push(items[next++]);
  return foldRepeats(out);
}

// A run of the same gateway notice (a restart says the same thing each time) shows once, with a count.
const folded = new WeakMap<ChatNotice, { count: number; until: number; item: ChatMessage }>();

function foldRepeats(rows: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < rows.length; i++) {
    const first = rows[i].notice;
    if (!first || first.source !== "notice" || first.attachments?.length) {
      out.push(rows[i]);
      continue;
    }
    let j = i;
    while (j + 1 < rows.length && rows[j + 1].notice?.source === "notice" && !rows[j + 1].notice!.attachments?.length && rows[j + 1].notice!.text.trim() === first.text.trim()) j++;
    if (j === i) {
      out.push(rows[i]);
      continue;
    }
    const count = j - i + 1;
    const until = rows[j].notice!.at;
    let hit = folded.get(first);
    if (!hit || hit.count !== count || hit.until !== until) {
      hit = { count, until, item: { ...rows[i], notice: { ...first, repeat: count, until } } };
      folded.set(first, hit);
    }
    out.push(hit.item);
    i = j;
  }
  return out;
}

type MsgRow = Extract<Row, { kind: "msg" }>;
type ToolsRow = Extract<Row, { kind: "tools" }>;
type DayRow = Extract<Row, { kind: "day" }>;

/*
 * Rows are rebuilt on every update, but a row whose message and neighbours didn't change is handed back as the
 * same object, so `memo(MessageRow)` skips it: a new reply re-renders one row, not the whole thread (each row
 * runs the Markdown pipeline). Caches are keyed by the message objects, which the chat keeps across updates.
 */
const msgRows = new WeakMap<ChatMessage, MsgRow>();
const toolRows = new WeakMap<ChatMessage, ToolsRow>();
const dayRows = new Map<string, DayRow>();

function msgRow(m: ChatMessage, key: string, mine: boolean, first: boolean, last: boolean): MsgRow {
  const hit = msgRows.get(m);
  if (hit && hit.key === key && hit.mine === mine && hit.first === first && hit.last === last) return hit;
  const row: MsgRow = { kind: "msg", key, m, mine, first, last };
  msgRows.set(m, row);
  return row;
}

function toolsRow(items: ChatMessage[]): ToolsRow {
  const hit = toolRows.get(items[0]);
  if (hit && hit.items.length === items.length && hit.items.every((m, i) => m === items[i])) return hit;
  const row: ToolsRow = { kind: "tools", key: `tools-${items[0].id}`, items };
  toolRows.set(items[0], row);
  return row;
}

function dayRow(key: string, label: string): DayRow {
  const hit = dayRows.get(key);
  if (hit && hit.label === label) return hit;
  const row: DayRow = { kind: "day", key, label };
  if (dayRows.size > 400) dayRows.clear();
  dayRows.set(key, row);
  return row;
}

/** Groups, day separators and collapsed tool runs. */
export function buildRows(messages: ChatMessage[]): Row[] {
  const rows: Row[] = [];
  // Each day's separator once: rows are in transcript order, and a row's time can step back to an earlier day
  // (a notice, or a message the gateway dated late), which would repeat a separator (and its key).
  const shownDays = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const ms = m.id >= OPTIMISTIC ? Date.now() : messageTimeMs(m.timestamp);
    if (Number.isFinite(ms)) {
      const day = new Date(ms).toDateString();
      if (!shownDays.has(day)) {
        rows.push(dayRow(`day-${day}`, dayLabel(ms)));
        shownDays.add(day);
      }
    }
    // The question itself shows as a card, and later as the question and its answer: no tool chip for it.
    if (isToolOnly(m) && m.tools?.length && m.tools.every((t) => t === "clarify")) continue;
    if (isToolOnly(m)) {
      const run = [m];
      while (i + 1 < messages.length && isToolOnly(messages[i + 1])) run.push(messages[++i]);
      rows.push(toolsRow(run));
      continue;
    }
    if (m.notice || m.asked) {
      rows.push(msgRow(m, m.notice ? `n-${m.notice.id}` : `m-${m.id}`, false, true, true));
      continue;
    }
    const mine = m.role === "user" && !isMachineNote(chatTone(m));
    const prev = messages[i - 1];
    const next = messages[i + 1];
    // A notice or a past question is its own block: the message after it starts a new group (with the face).
    const sameSide = (o?: ChatMessage) => !!o && !o.notice && !o.asked && (o.role === "user" && !isMachineNote(chatTone(o))) === mine;
    rows.push(msgRow(m, `m-${m.id}`, mine, !sameSide(prev), !sameSide(next)));
  }
  return rows;
}

export function Thread({
  messages,
  chief,
  awaiting,
  waitingApproval,
  connected,
  authFailed,
  onSuggestion,
  onCancelQueued,
  onRetryQueued,
  earlier,
  onLoadEarlier,
  footer,
  header,
  notices,
  activity,
  question,
  onAnswer,
  onQuickReply,
  loading = false,
}: {
  messages: ChatMessage[];
  /** The first transcript hasn't arrived yet: placeholders instead of the empty-chat greeting. */
  loading?: boolean;
  chief: Person | undefined;
  awaiting: boolean;
  waitingApproval: boolean;
  connected: boolean;
  authFailed?: boolean;
  onSuggestion: (text: string) => void;
  /** Takes a message waiting in the outbox back out (lib/outbox.ts). */
  onCancelQueued?: (queueId: string) => void;
  /** Tries the outbox again now (a failed send's "Retry now"). */
  onRetryQueued?: () => void;
  /** Load earlier at the top of the thread: whether older messages remain, and its progress. */
  earlier?: { more: boolean; loading: boolean; error: string };
  onLoadEarlier?: () => void;
  footer?: ReactNode;
  /** Shown at the top of the thread, empty or not (the thread's earlier conversations). */
  header?: ReactNode;
  /** Scheduled-job results and gateway notices, shown in time order. */
  notices?: ChatNotice[];
  /** What the running turn is doing now. */
  activity?: TurnActivity | null;
  /** The chief's open question (the turn waits for the answer), and how to answer it. */
  question?: PendingQuestion | null;
  onAnswer?: (id: string, answer: string | string[]) => Promise<void>;
  /** Sends a gateway prompt's answer (e.g. "/approve") from the buttons on the newest notice. */
  onQuickReply?: (text: string) => Promise<void>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  // Pinned / idle rules live in lib/stick-to-bottom.ts.
  const [stickState] = useState(() => new StickState());
  const stick = useRef(stickState);
  const markUser = () => stick.current.gesture(Date.now());
  const [unread, setUnread] = useState(0);
  const seen = useRef<Set<number> | null>(null);
  // Sticky per message: once a message animates in, it keeps the same props so a re-render never cuts it short.
  const animated = useRef(new Set<number>());
  const rows = useMemo(() => buildRows(withNotices(messages, notices)), [messages, notices]);
  const lastMsgRow = [...rows].reverse().find((r) => r.kind === "msg");
  // The oldest message id shown, and the scroll height before the last change (Load earlier anchoring).
  const oldest = useRef(0);
  const heightBefore = useRef(0);

  // Messages present at first paint (history) don't animate; anything that arrives later does.
  // Older messages loaded at the top (Load earlier) are history too: no animation, no "new" count.
  if (seen.current === null && messages.length) seen.current = new Set(messages.map((m) => m.id));
  if (!messages.length) {
    seen.current = null;
    animated.current.clear();
  }
  const firstKey = messages.length ? messages[0].id : 0;
  if (!messages.length) oldest.current = 0;
  const prepended = !!seen.current && oldest.current > 0 && firstKey > 0 && firstKey < oldest.current;
  const fresh = new Set<number>();
  if (seen.current) {
    for (const m of messages) {
      if (seen.current.has(m.id)) continue;
      if (oldest.current > 0 && m.id < oldest.current) seen.current.add(m.id);
      else fresh.add(m.id);
    }
  }
  for (const id of fresh) animated.current.add(id);

  const lastKey = messages.length ? messages[messages.length - 1].id : 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    oldest.current = firstKey > 0 && firstKey < OPTIMISTIC ? firstKey : oldest.current;
    if (prepended) {
      // Keep the message you were reading where it was, with the older ones above it.
      el.scrollTop += el.scrollHeight - heightBefore.current;
      heightBefore.current = el.scrollHeight;
      return;
    }
    heightBefore.current = el.scrollHeight;
    const newOnes = [...fresh];
    const mineSent = newOnes.some((id) => {
      if (id >= OPTIMISTIC) return true;
      const m = messages.find((x) => x.id === id);
      return m?.role === "user" && !isMachineNote(chatTone(m));
    });
    const firstPaint = !seen.current || seen.current.size === 0;
    if (firstPaint || stick.current.follow(mineSent ? "mine" : "incoming", Date.now())) {
      toBottom(el, newOnes.length > 0);
      setUnread(0);
    } else {
      const incoming = messages.filter((m) => fresh.has(m.id) && m.role !== "user").length;
      if (incoming) setUnread((n) => n + incoming);
    }
    for (const id of newOnes) seen.current?.add(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastKey, messages.length, firstKey]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current.follow("incoming", Date.now())) toBottom(el, true);
  }, [awaiting, question?.id, notices?.length]);

  // Images and videos grow the thread after it renders; stay pinned to the bottom unless you scrolled up.
  const content = useRef<HTMLDivElement>(null);
  const empty = messages.length === 0;
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    // Coming back to the Chat tab (display: none → shown) counts as a chance to catch up.
    let shownHeight = el.clientHeight;
    const ro = new ResizeObserver(() => {
      heightBefore.current = el.scrollHeight;
      const wasHidden = shownHeight === 0;
      shownHeight = el.clientHeight;
      if (!shownHeight) return;
      if (stick.current.follow(wasHidden ? "shown" : "grow", Date.now())) {
        toBottom(el, false);
        setUnread(0);
      }
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, [empty]);

  const thinkingSince = useRef<number | null>(null);
  if (awaiting && thinkingSince.current === null) thinkingSince.current = Date.now();
  if (!awaiting) thinkingSince.current = null;

  return (
    <div className="relative min-h-0 flex-1">
      {/* The listeners only note that the owner scrolled by hand (stop following new rows); nothing to activate. */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        ref={scroller}
        // Up and down only: one too-wide thing in a message (an image, a table, a long link) must never let the
        // whole conversation slide sideways on a phone.
        className="h-full overflow-y-auto overflow-x-hidden overscroll-contain px-4 pb-4 pt-3"
        onWheel={markUser}
        onTouchMove={markUser}
        onPointerDown={markUser}
        onKeyDown={markUser}
        onClickCapture={(e) => {
          // Vault links (paths and [[notes]] the chief mentions) open in the Vault tab, not a browser tab.
          const link = parseVaultHref((e.target as Element | null)?.closest?.("a")?.getAttribute("href") ?? null);
          if (!link) return;
          e.preventDefault();
          e.stopPropagation();
          openInVault(link.ref, link.from);
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current.scroll(el.scrollTop, el.scrollHeight, el.clientHeight, Date.now());
          heightBefore.current = el.scrollHeight;
          if (stick.current.pinned && unread) setUnread(0);
        }}
      >
        {messages.length === 0 && header ? <div className="mx-auto max-w-3xl">{header}</div> : null}
        {messages.length === 0 && loading ? (
          <ThreadSkeleton />
        ) : messages.length === 0 ? (
          <EmptyState chief={chief} connected={connected} authFailed={authFailed} onSuggestion={onSuggestion} />
        ) : (
          <div ref={content} className="mx-auto flex max-w-3xl flex-col">
            {header}
            {earlier && onLoadEarlier ? <EarlierRow state={earlier} onLoad={onLoadEarlier} /> : null}
            {rows.map((row) => {
              if (row.kind === "day") return <DaySeparator key={row.key} label={row.label} />;
              if (row.kind === "tools") return <ToolRun key={row.key} items={row.items} animate={row.items.some((m) => animated.current.has(m.id))} />;
              return (
                <MessageRow
                  key={row.key}
                  row={row}
                  chief={chief}
                  animate={animated.current.has(row.m.id)}
                  onCancelQueued={onCancelQueued}
                  onRetryQueued={onRetryQueued}
                  onQuickReply={row.m.notice && row === lastMsgRow ? onQuickReply : undefined}
                />
              );
            })}
            <AnimatePresence>
              {question && onAnswer ? (
                <QuestionCard key={`q-${question.id}`} question={question} chief={chief} onAnswer={onAnswer} />
              ) : awaiting ? (
                <ThinkingRow
                  key="thinking"
                  chief={chief}
                  waitingApproval={waitingApproval}
                  since={activity?.since ? activity.since * 1000 : (thinkingSince.current ?? Date.now())}
                  step={activity?.label}
                />
              ) : null}
            </AnimatePresence>
          </div>
        )}
        {footer}
      </div>
      <AnimatePresence>
        {unread > 0 ? (
          <motion.button
            key="jump"
            type="button"
            className="glass absolute bottom-3 left-1/2 z-10 flex min-h-10 -translate-x-1/2 items-center gap-1.5 rounded-full px-3.5 text-callout font-medium text-fg"
            initial={{ opacity: 0, y: 12, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING.bouncy }}
            exit={{ opacity: 0, y: 8, transition: { duration: 0.14 } }}
            onClick={() => {
              stick.current.follow("mine", Date.now());
              if (scroller.current) toBottom(scroller.current, true);
              setUnread(0);
            }}
          >
            <ArrowDownIcon size={16} />
            {unread} new {unread === 1 ? "reply" : "replies"}
          </motion.button>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function EarlierRow({ state, onLoad }: { state: { more: boolean; loading: boolean; error: string }; onLoad: () => void }) {
  if (!state.more) return <p className="mb-3 text-center text-caption text-fg-4">Start of the conversation</p>;
  return (
    <div className="mb-3 flex flex-col items-center gap-1">
      <button
        type="button"
        disabled={state.loading}
        onClick={onLoad}
        className="press min-h-9 rounded-full border border-line-2 px-3.5 text-caption font-medium text-fg-2 hover:text-fg disabled:opacity-60"
      >
        {state.loading ? "Loading…" : "Load earlier"}
      </button>
      {state.error ? <p className="text-caption text-warn">{state.error}</p> : null}
    </div>
  );
}

function DaySeparator({ label }: { label: string }) {
  return (
    <div className="my-4 flex items-center gap-3 first:mt-0" role="separator">
      <span className="h-px flex-1 bg-line" />
      <span className="text-caption font-medium text-fg-3">{label}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

const enterChief = {
  initial: { opacity: 0, y: 8, filter: "blur(4px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.26, ease: EASE.enter } },
};
const enterMine = {
  initial: { opacity: 0, y: 22, scale: 0.94 },
  animate: { opacity: 1, y: 0, scale: 1, transition: SPRING.bouncy },
};

type RowProps = {
  row: Extract<Row, { kind: "msg" }>;
  chief: Person | undefined;
  animate: boolean;
  onCancelQueued?: (queueId: string) => void;
  onRetryQueued?: () => void;
  onQuickReply?: (text: string) => Promise<void>;
};

const MessageRow = memo(function MessageRow({ row, chief, animate, onCancelQueued, onRetryQueued, onQuickReply }: RowProps) {
  const { m, first, last, mine } = row;
  const tone = chatTone(m);
  const text = stripMediaTags(m.content || "");
  const time = clock(m.id >= OPTIMISTIC ? Date.now() : messageTimeMs(m.timestamp));
  const motionProps = animate ? (mine ? enterMine : enterChief) : {};

  if (m.notice || m.asked) {
    return (
      <motion.div {...motionProps} className="mt-5 flex gap-2.5">
        <div className="w-7 shrink-0" />
        <div className="min-w-0 flex-1">
          {m.notice ? (
            <>
              {m.notice.text.trim() ? <NoticeBody notice={m.notice} onQuickReply={onQuickReply} /> : null}
              <MessageMedia attachments={m.notice.attachments} />
            </>
          ) : (
            <AskedRow items={m.asked!} />
          )}
          {time ? <span className="mt-1 block text-caption text-fg-3">{time}</span> : null}
        </div>
      </motion.div>
    );
  }

  if (isMachineNote(tone)) {
    return (
      <motion.div {...motionProps} className={`${first ? "mt-3" : "mt-1.5"} pl-9`}>
        <NoteChip tone={tone} text={text} tools={m.tools} attachments={m.attachments} />
      </motion.div>
    );
  }

  if (mine) {
    return (
      <motion.div {...motionProps} style={{ originX: 1, originY: 1 }} className={`flex flex-col items-end ${first ? "mt-4" : "mt-1"}`}>
        <div
          className={`max-w-[82%] rounded-sheet bg-well px-3.5 py-2 text-fg shadow-[inset_0_0_0_1px_rgb(255_255_255/0.04)] ${last ? "rounded-br-md" : ""} ${m.id >= OPTIMISTIC ? "opacity-80" : ""}`}
        >
          {text ? <EmojiText text={text} /> : null}
          <MessageMedia attachments={m.attachments} />
        </div>
        {m.steered ? <span className="mt-1 pr-1 text-caption text-fg-3">Added while working</span> : null}
        {m.delivery === "queued" ? (
          <QueuedFooter m={m} onCancel={onCancelQueued} onRetry={onRetryQueued} />
        ) : last && time ? (
          <span className="mt-1 pr-1 text-caption text-fg-3">{m.id >= OPTIMISTIC ? (m.delivery === "sent" ? "Sent" : "Sending…") : time}</span>
        ) : null}
      </motion.div>
    );
  }

  return (
    <motion.div {...motionProps} className={`group flex gap-2.5 ${first ? "mt-5" : "mt-2"}`}>
      <div className="w-7 shrink-0 pt-0.5">
        {first && chief ? (
          <BotFace {...faceProps(chief)} size={28} still />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        {text ? <Streamdown className="chat-md max-w-none">{plainCustomEmoji(linkifyVaultRefs(text))}</Streamdown> : null}
        <MessageMedia attachments={m.attachments} />
        {!text && !m.attachments?.length ? <span className="text-fg-3">…</span> : null}
        {(last && time) || text ? (
          <div className="mt-1 flex min-h-7 items-center gap-1">
            {last && time ? <span className="text-caption text-fg-3">{time}</span> : null}
            {text ? <ReplyActions text={text} /> : null}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}, sameRow);

/**
 * Rows are rebuilt whenever a message arrives, so compare what a row shows rather than the row
 * object: otherwise every message (and its markdown) re-renders on every new reply.
 */
function sameRow(a: RowProps, b: RowProps) {
  return (
    a.onCancelQueued === b.onCancelQueued &&
    a.onRetryQueued === b.onRetryQueued &&
    a.onQuickReply === b.onQuickReply &&
    a.row.m === b.row.m &&
    a.row.first === b.row.first &&
    a.row.last === b.row.last &&
    a.row.mine === b.row.mine &&
    a.chief === b.chief &&
    a.animate === b.animate
  );
}

/** Under a message waiting in the outbox: why it hasn't gone, and a way to take it back. */
function QueuedFooter({ m, onCancel, onRetry }: { m: ChatMessage; onCancel?: (queueId: string) => void; onRetry?: () => void }) {
  const assistant = useAssistantName();
  const files = m.queueFiles?.length ? ` · with ${m.queueFiles.join(", ")}` : "";
  return (
    <span className="mt-1 flex max-w-[82%] flex-wrap items-center justify-end gap-x-2 pr-1 text-caption text-warn">
      <span>
        {m.queueNote ? `Couldn't reach ${assistant} · retrying` : `Queued · sends when ${assistant} is back`}
        {files}
      </span>
      {onRetry && m.queueNote ? (
        <button type="button" className="press min-h-8 font-medium text-fg-2 underline hover:text-fg" onClick={onRetry}>
          Retry now
        </button>
      ) : null}
      {onCancel && m.queueId ? (
        <button type="button" className="press min-h-8 font-medium text-fg-2 underline hover:text-fg" onClick={() => onCancel(m.queueId!)}>
          Cancel
        </button>
      ) : null}
    </span>
  );
}

const ACTION =
  "press grid size-7 place-items-center rounded-full text-fg-3 transition-opacity duration-fast hover:bg-fill-2 hover:text-fg focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-70";

/**
 * A reply's actions: copy its text (as written, markdown included) and read it aloud. They show on hover and
 * keyboard focus, and always (dimmed) on touch screens, so the phone needs no long-press to find them.
 */
function ReplyActions({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <>
      <Tip label={copied ? "Copied" : "Copy"} side="top">
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy reply"}
          className={`${ACTION} ${copied ? "opacity-100" : "opacity-0"}`}
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
          }}
        >
          {copied ? <CheckIcon size={14} className="text-ok" /> : <CopyIcon size={14} />}
        </button>
      </Tip>
      <Tip label="Read aloud" side="top">
        <button type="button" aria-label="Read aloud" className={`${ACTION} opacity-0`} onClick={() => readAloud(text)}>
          <Volume2Icon size={14} />
        </button>
      </Tip>
    </>
  );
}

const NOTE: Record<Exclude<ChatTone, "reply">, { name: string; Icon: (p: IconProps) => React.ReactElement; tone: string }> = {
  tool: { name: "Tool", Icon: WrenchIcon, tone: "text-fg-3" },
  kanban: { name: "Kanban", Icon: ListChecksIcon, tone: "text-ok" },
  system: { name: "System note", Icon: ShieldAlertIcon, tone: "text-warn" },
  compaction: { name: "Context compacted", Icon: SparklesIcon, tone: "text-fg-3" },
  origin: { name: "Origin", Icon: BotIcon, tone: "text-fg-3" },
  error: { name: "Error", Icon: CircleAlertIcon, tone: "text-danger" },
};

function NoteChip({ tone, text, tools, attachments }: { tone: ChatTone; text: string; tools?: string[]; attachments?: ChatMessage["attachments"] }) {
  const meta = NOTE[tone as Exclude<ChatTone, "reply">] || NOTE.tool;
  const [open, setOpen] = useState(tone === "error");
  const names = uniqueToolNames(tools);
  const title = tone === "tool" && names.length ? names.join(", ") : notePreview(text);
  const Icon = meta.Icon;
  return (
    <div className={`inline-flex max-w-full flex-col rounded-card border ${tone === "error" ? "border-danger/30 bg-danger/[0.07]" : "border-line bg-card"}`}>
      <button type="button" className="press flex min-h-9 max-w-full items-center gap-2 px-3 text-left text-callout" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon size={14} className={`shrink-0 ${meta.tone}`} />
        <span className={`shrink-0 font-medium ${meta.tone}`}>{meta.name}</span>
        {title ? <span className="min-w-0 truncate text-fg-3">{title}</span> : null}
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={SPRING.snappy} className="shrink-0 text-fg-4">
          <ChevronRightIcon size={14} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            className="overflow-hidden"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1, transition: SPRING.gentle }}
            exit={{ height: 0, opacity: 0, transition: { duration: 0.16 } }}
          >
            <div className="max-h-64 overflow-auto px-3 pb-3 text-callout text-fg-2">
              {text ? <EmojiText text={tone === "tool" ? text.slice(0, 800) : text} /> : null}
              <MessageMedia attachments={attachments} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

type Step = { m: ChatMessage; label: string; names: string[]; failed: boolean; took: string };

function toolSteps(items: ChatMessage[]): Step[] {
  return items.map((m, i) => {
    const names = uniqueToolNames(m.tools);
    const next = items[i + 1];
    const took = next ? stepDuration(messageTimeMs(next.timestamp) - messageTimeMs(m.timestamp)) : "";
    const labels = Array.from(new Set((names.length ? names : ["tool"]).map(toolLabel)));
    return { m, label: labels.join(", "), names, failed: looksFailed(stripMediaTags(m.content || "")), took };
  });
}

/**
 * The chief's tool steps as one collapsible timeline: what it did, in plain words, how long each step took, and
 * a failed step tinted (and its output a tap away).
 */
function ToolRun({ items, animate }: { items: ChatMessage[]; animate: boolean }) {
  const [open, setOpen] = useState(false);
  const steps = useMemo(() => toolSteps(items), [items]);
  const failures = steps.filter((s) => s.failed).length;
  const total = items.length > 1 ? stepDuration(messageTimeMs(items[items.length - 1].timestamp) - messageTimeMs(items[0].timestamp)) : "";
  const summary = Array.from(new Set(steps.map((s) => s.label))).join(" · ");
  return (
    <motion.div {...(animate ? enterChief : {})} className="mt-1.5 pl-9">
      <div className={`inline-flex max-w-full flex-col rounded-card border ${failures ? "border-danger/30" : "border-line"} bg-card`}>
        <button type="button" className="press flex min-h-9 max-w-full items-center gap-2 px-3 text-left text-callout" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <WrenchIcon size={14} className="shrink-0 text-fg-3" />
          <span className="shrink-0 font-medium text-fg-2">{steps.length === 1 ? "1 step" : `${steps.length} steps`}</span>
          <span className="min-w-0 truncate text-fg-3">{summary}</span>
          {failures ? <span className="shrink-0 text-caption font-medium text-danger">{failures} failed</span> : null}
          {total ? <span className="shrink-0 font-mono text-micro tabular text-fg-3">{total}</span> : null}
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={SPRING.snappy} className="shrink-0 text-fg-4">
            <ChevronRightIcon size={14} />
          </motion.span>
        </button>
        <AnimatePresence initial={false}>
          {open ? (
            <motion.ol
              aria-label="Tool steps"
              className="overflow-hidden border-t border-line"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1, transition: SPRING.gentle }}
              exit={{ height: 0, opacity: 0, transition: { duration: 0.16 } }}
            >
              {steps.map((step, i) => (
                <ToolStep key={step.m.id} step={step} last={i === steps.length - 1} />
              ))}
            </motion.ol>
          ) : null}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function ToolStep({ step, last }: { step: Step; last: boolean }) {
  const [open, setOpen] = useState(step.failed);
  const output = stripMediaTags(step.m.content || "").trim();
  return (
    <li className="relative pl-8 pr-3">
      {!last ? <span aria-hidden className="absolute bottom-0 left-[1.05rem] top-5 w-px bg-line" /> : null}
      <span aria-hidden className={`absolute left-3 top-3.5 grid size-3 place-items-center rounded-full ${step.failed ? "bg-danger/25" : "bg-fill-3"}`}>
        <span className={`size-1.5 rounded-full ${step.failed ? "bg-danger" : "bg-fg-3"}`} />
      </span>
      <button
        type="button"
        className="press flex min-h-10 w-full items-center gap-2 text-left text-callout disabled:cursor-default"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={output ? open : undefined}
        disabled={!output}
      >
        <span className={`min-w-0 flex-1 truncate ${step.failed ? "text-danger" : "text-fg-2"}`}>{step.label}</span>
        {step.names.length ? <span className="hidden max-w-[40%] truncate font-mono text-micro text-fg-3 sm:inline">{step.names.join(", ")}</span> : null}
        {step.took ? <span className="shrink-0 font-mono text-micro tabular text-fg-3">{step.took}</span> : null}
      </button>
      {open && output ? (
        <pre className={`mb-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-ctl px-2.5 py-2 font-mono text-micro ${step.failed ? "bg-danger/[0.07] text-fg-2" : "bg-well text-fg-3"}`}>
          {output.slice(0, 1200)}
        </pre>
      ) : null}
    </li>
  );
}

function useElapsed(since: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1000));
}

function ThinkingRow({ chief, waitingApproval, since, step }: { chief: Person | undefined; waitingApproval: boolean; since: number; step?: string }) {
  const assistant = useAssistantName();
  const seconds = useElapsed(since);
  // The current step in plain words ("Checking the team"); plain "thinking" until the first one.
  const doing = step && step !== "Thinking" ? `${step}…` : `${assistant} is thinking…`;
  return (
    <motion.div
      className="mt-5 flex items-center gap-2.5"
      aria-live="polite"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: EASE.enter } }}
      exit={{ opacity: 0, transition: { duration: 0.14 } }}
    >
      <div className="w-7 shrink-0">
        {chief ? (
          <BotFace {...faceProps(chief)} mood={waitingApproval ? "waiting" : "thinking"} size={28} />
        ) : null}
      </div>
      <span className={`text-body font-medium ${waitingApproval ? "text-warn" : "shimmer-text"}`}>
        {waitingApproval ? "Waiting for your approval" : doing}
      </span>
      {!waitingApproval && seconds >= 5 ? (
        <span className="font-mono text-code tabular text-fg-3">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
      ) : null}
    </motion.div>
  );
}

const SUGGESTIONS = ["What's on my plate today?", "Give me a fleet status", "What did you finish since yesterday?"];

function EmptyState({
  chief,
  connected,
  authFailed,
  onSuggestion,
}: {
  chief: Person | undefined;
  connected: boolean;
  authFailed?: boolean;
  onSuggestion: (text: string) => void;
}) {
  const assistant = useAssistantName();
  const offline = !connected || authFailed;
  return (
    <motion.div
      className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE.enter } }}
    >
      {chief ? (
        <div className="py-6">
          <ChiefPresence chief={chief} size={96} mood={offline ? "offline" : "online"} />
        </div>
      ) : null}
      {authFailed ? (
        <>
          <h2 className="mt-6 text-title text-fg">{assistant} can&apos;t let this window in</h2>
          <p className="mt-2 max-w-xs text-body text-fg-3">Bridge token does not match the plugin.</p>
        </>
      ) : !connected ? (
        <>
          <h2 className="mt-6 text-title text-fg">{assistant}&apos;s gateway is offline</h2>
          <p className="mt-2 max-w-xs text-body text-fg-3">Cannot reach {assistant} until the bridge is up. It will reconnect on its own.</p>
        </>
      ) : (
        <>
          <h2 className="mt-6 text-title text-fg">Say hi to {assistant}</h2>
          <p className="mt-2 max-w-xs text-body text-fg-3">No messages in this session yet. Ask for a brief, hand over a task, or hold the mic and talk.</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((s, i) => (
              <motion.button
                key={s}
                type="button"
                className="press min-h-10 rounded-full border border-line-2 bg-card px-4 text-callout text-fg-2 hover:border-line-3 hover:text-fg"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0, transition: { delay: 0.15 + i * 0.05, duration: 0.3, ease: EASE.enter } }}
                onClick={() => onSuggestion(s)}
              >
                {s}
              </motion.button>
            ))}
          </div>
        </>
      )}
    </motion.div>
  );
}

/** Placeholder rows while the first transcript loads: a reply, your message, a reply. */
function ThreadSkeleton() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 pt-6" role="status" aria-label="Loading the conversation">
      <div className="flex gap-3">
        <div className="skeleton size-8 shrink-0 rounded-full" />
        <div className="flex-1 space-y-2.5 pt-1">
          <div className="skeleton h-3.5 w-[88%] rounded-full" />
          <div className="skeleton h-3.5 w-[64%] rounded-full" />
        </div>
      </div>
      <div className="skeleton ml-auto h-10 w-[46%] rounded-card" />
      <div className="flex gap-3">
        <div className="skeleton size-8 shrink-0 rounded-full" />
        <div className="flex-1 space-y-2.5 pt-1">
          <div className="skeleton h-3.5 w-[92%] rounded-full" />
          <div className="skeleton h-3.5 w-[78%] rounded-full" />
          <div className="skeleton h-3.5 w-[40%] rounded-full" />
        </div>
      </div>
    </div>
  );
}
