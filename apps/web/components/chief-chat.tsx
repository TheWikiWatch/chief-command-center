"use client";

import { useAttentiveGaze } from "@/lib/use-attentive-gaze";
import dynamic from "next/dynamic";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import "blobatar/gaze.css";

import { poll } from "@/lib/poll";
import { useResourceHealth } from "@/components/resource-status";
import { staleWindow } from "@/lib/health-store";
import { ChiefPresence } from "@/components/presence";
import { ApprovalSheet } from "@/components/chat/approval-sheet";
import { chiefColor } from "@/lib/bot-identity";
import { ChatHeader, type ChiefMood } from "@/components/chat/chat-header";
import { FollowupCards, followupAsk, useFollowupWatch } from "@/components/chat/followup-cards";
import { Composer, type PendingFile } from "@/components/chat/composer";
import { Thread } from "@/components/chat/thread";
import { PreviousConversations } from "@/components/chat/previous-conversations";
import { CheckIcon, PaperclipIcon, XIcon } from "@/components/icons";
import { type MicStatus } from "@/components/mic-button";
import { meterStream } from "@/lib/audio-level";
import { fx } from "@/lib/fx";
import { answerQuestion, fetchEarlier, fetchTranscript, fetchVoiceConfig, resolveApproval, sendToChief, stopTurn, type OutboundAttachment } from "@/lib/bridge";
import { VOICE_FALLBACK_EVENT } from "@/lib/voice-events";
import { SHOW_APPROVAL_EVENT } from "@/lib/open-target";
import { chatTone, isMachineNote } from "@/lib/chat-tone";
import { computeThinkingChrome, shouldClearPendingReply } from "@/lib/thinking-chrome";
import { visibleMessages } from "@/lib/compact-filter";
import { fullPhotosOn, useDashboardPrefs, VOICE_EVENT } from "@/lib/dashboard-prefs";
import { getSpeechPhase, blobToDataUrl, stopSpeech, subscribeSpeaking, toggleSpeechPause } from "@/lib/voice-client";
import type { ApprovalChoice, ChatAttachment, ChatMessage, ChatNotice, ExecApproval, PendingQuestion, Person, PreviousConversation, Transcript, TurnActivity, BackgroundUnit } from "@/lib/types";
import { BackgroundWork, backgroundTaskCount } from "@/components/chat/background-work";
import { admitFiles } from "@/lib/upload-limits";
import { shrinkImage } from "@/lib/image-shrink";
import { retryable, type QueuedSend } from "@/lib/outbox";
import { useOutbox } from "@/components/chat/use-outbox";
import { logSpeech } from "@/lib/speech-log";
import { dropReplays, sameText } from "@/lib/replay-guard";
import { useAssistantName, assistantName } from "@/lib/identity";
import { createDraftStore, useDraft, type DraftStore } from "@/lib/draft-store";
import { speechFailureReason, useReplySpeech } from "@/components/chat/use-reply-speech";
import { focusComposer, OPEN_VOICE_MODE_EVENT, SET_DRAFT_EVENT } from "@/lib/app-events";

// Voice mode loads the first time it is opened.
const VoiceMode = dynamic(() => import("@/components/chat/voice-mode").then((m) => m.VoiceMode), { ssr: false });

/** A reply that was not read aloud: it failed, arrived while you were away, or was held behind a newer one. */
/** The unsent message survives a reload (Android can drop the app from memory mid-thought). */
const DRAFT_KEY = "chief-chat-draft";

export type ChatSend = (text: string) => Promise<void>;

export function ChiefChat({
  chief,
  people = [],
  lookAtEl,
  connected,
  authFailed,
  approval,
  onSendReady,
  compact,
  onThinkingChange,
  onApprovalResolved,
  onApprovalUpdate,
  onOpenSettings,
  threadSwitcher,
  onOpenStatus,
}: {
  chief: Person | undefined;
  /** The fleet, for faces on follow-up reminders. */
  people?: Person[];
  lookAtEl: HTMLElement | null;
  connected: boolean;
  authFailed?: boolean;
  approval?: ExecApproval | null;
  onSendReady?: (send: ChatSend | null) => void;
  compact?: boolean;
  onThinkingChange?: (thinking: boolean) => void;
  onApprovalResolved?: (requestId: string) => void;
  /** The pending approval as the bridge reported it with the transcript (so the shell needn't poll it). */
  onApprovalUpdate?: (approval: ExecApproval | null) => void;
  onOpenSettings?: () => void;
  /** The thread switcher shown in the chat header (threads: separate conversations with the chief). */
  threadSwitcher?: ReactNode;
  onOpenStatus?: () => void;
}) {
  const assistant = useAssistantName();
  const lookAtRef = useRef(lookAtEl);
  lookAtRef.current = lookAtEl;
  const { ref } = useAttentiveGaze(() => lookAtRef.current);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const lastIdRef = useRef(0);
  // The draft lives in a store only the message box subscribes to (lib/draft-store.ts): typing doesn't
  // re-render the chat. Sends read it with draft.get().
  const [draft] = useState(() => createDraftStore(""));
  const setText = draft.set;
  useEffect(() => {
    try {
      const saved = localStorage.getItem(DRAFT_KEY);
      if (saved) setText((current) => current || saved);
    } catch {
      /* private mode */
    }
  }, [setText]);
  useEffect(() => {
    let timer: number | undefined;
    const unsubscribe = draft.subscribe(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        try {
          const text = draft.get();
          if (text) localStorage.setItem(DRAFT_KEY, text);
          else localStorage.removeItem(DRAFT_KEY);
        } catch {
          /* private mode */
        }
      }, 300);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer);
    };
  }, [draft]);
  // Files dragged over the chat (desktop): a drop target over the whole pane.
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const [busy, setBusy] = useState(false);
  const [pendingReply, setPendingReply] = useState(false);
  const busyRef = useRef(false);
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  generatingRef.current = generating;
  // Messages to send once the chief finishes the current turn ("Send after"), oldest first.
  const [afterQueue, setAfterQueue] = useState<{ id: string; text: string }[]>([]);
  // What was added to running work this session, so its stored copy keeps the "Added while working" tag.
  const steeredTexts = useRef(new Set<string>());
  const [stopping, setStopping] = useState(false);
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  const [approvalError, setApprovalError] = useState("");
  const [sendError, setSendError] = useState("");
  const [sendNotice, setSendNotice] = useState("");
  // Once the bridge can hold requests (?wait=), the chat long-polls: a reply shows the moment it
  // lands, and an idle chat makes one request every 25s instead of one every 2.5s.
  const [longpoll, setLongpoll] = useState(false);
  const longpollRef = useRef(false);
  const bridgeState = useRef<{ generating: boolean; approval: string; clarify: string; notice: string; bg?: string }>({ generating: false, approval: "", clarify: "", notice: "" });
  // The chief's open question (its turn waits for the answer), notices that aren't replies, and its current step.
  const [question, setQuestion] = useState<PendingQuestion | null>(null);
  const questionRef = useRef<PendingQuestion | null>(null);
  questionRef.current = question;
  const [notices, setNotices] = useState<ChatNotice[]>([]);
  const noticeSince = useRef(0);
  const [activity, setActivity] = useState<TurnActivity | null>(null);
  const [background, setBackground] = useState<BackgroundUnit[]>([]);
  const [previous, setPrevious] = useState<PreviousConversation[]>([]);
  const quickReturns = useRef(0);
  const failStreak = useRef(0);
  const approvalUpdate = useRef(onApprovalUpdate);
  approvalUpdate.current = onApprovalUpdate;
  const transcriptHealth = useResourceHealth("Chat", longpoll ? 40_000 : staleWindow(2500));
  const [earlier, setEarlier] = useState<{ more: boolean; loading: boolean; error: string }>({ more: true, loading: false, error: "" });
  const awaitingRef = useRef(false);
  useEffect(() => { setApprovalError(""); }, [approval?.requestId]);
  const [approvalMin, setApprovalMin] = useState(false);
  useEffect(() => { setApprovalMin(false); }, [approval?.requestId]);
  // A tapped approval notification brings the sheet back up if it was minimized to the pill.
  useEffect(() => {
    const show = () => setApprovalMin(false);
    window.addEventListener(SHOW_APPROVAL_EVENT, show);
    return () => window.removeEventListener(SHOW_APPROVAL_EVENT, show);
  }, []);
  const stopMicMeter = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => stopMicMeter.current?.(), []);
  const prefs = useDashboardPrefs(!!compact);
  const fontPx = prefs.fontPx;
  const speakOn = prefs.speakOn;
  const [voiceHint, setVoiceHint] = useState("");
  const [voiceOpen, setVoiceOpen] = useState(false);
  // Mounted from the first open on (it keeps its exit animation); before that, not even loaded.
  const [voiceMounted, setVoiceMounted] = useState(false);
  if (voiceOpen && !voiceMounted) setVoiceMounted(true);
  // The command palette and shortcuts open voice mode, and put text in the message box (never sending it).
  useEffect(() => {
    const openVoice = () => setVoiceOpen(true);
    const fill = (e: Event) => {
      const text = String((e as CustomEvent<{ text?: string }>).detail?.text || "");
      if (!text) return;
      draft.set(text);
      window.setTimeout(focusComposer, 0);
    };
    window.addEventListener(OPEN_VOICE_MODE_EVENT, openVoice);
    window.addEventListener(SET_DRAFT_EVENT, fill);
    return () => {
      window.removeEventListener(OPEN_VOICE_MODE_EVENT, openVoice);
      window.removeEventListener(SET_DRAFT_EVENT, fill);
    };
  }, [draft]);
  const [voiceLabel, setVoiceLabel] = useState("");
  // Until the first transcript arrives, the thread shows it is loading, not "no messages yet".
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [micStatus, setMicStatus] = useState<MicStatus>({ state: "idle", cancelling: false });
  const micPrev = useRef<MicStatus>({ state: "idle", cancelling: false });
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const approvalChime = useRef("");
  useEffect(() => {
    if (!approval?.requestId || approvalChime.current === approval.requestId) return;
    approvalChime.current = approval.requestId;
    fx("approval");
  }, [approval?.requestId]);
  const questionChime = useRef("");
  useEffect(() => {
    if (!question?.id || questionChime.current === question.id) return;
    questionChime.current = question.id;
    fx("approval");
  }, [question?.id]);
  const retrySend = useRef<{ signature: string; id: string } | null>(null);
  // Messages waiting for the chief (lib/outbox.ts): sent in order when it is reachable again.
  const onQueuedDelivered = useCallback((item: QueuedSend, previews: string[]) => {
    const images = item.files.filter(f => f.mime.startsWith("image/"));
    const bubble: ChatMessage = {
      id: Date.now(),
      role: "user",
      content: item.text,
      timestamp: new Date().toISOString(),
      delivery: "sent",
      attachments: previews.map((path, i) => ({ path, name: images[i]?.name || "photo", kind: "image", mime: images[i]?.mime || "image/jpeg" })),
    };
    if (previews.length) sentPreviews.current.set(bubble.id, previews);
    setMessages(m => [...m, bubble]);
    setPendingReply(true);
    fx("send");
  }, []);
  const onQueuedDropped = useCallback((item: QueuedSend, reason: string) => {
    setSendError(`A queued message wasn't sent: ${reason}${item.text ? " Its text is back in your draft." : ""}`);
    if (item.text) setText(current => (current.trim() ? current : item.text));
    fx("error");
  }, [setText]);
  const outbox = useOutbox({ ready: connected && !authFailed, onDelivered: onQueuedDelivered, onDropped: onQueuedDropped });
  const cancelQueued = useCallback(
    (queueId: string) => {
      const item = outbox.cancel(queueId);
      if (item?.text) setText(current => (current.trim() ? current : item.text));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outbox.cancel],
  );
  // Previews of sent files (blob: URLs) are released once their "Sending…" bubble is replaced.
  const sentPreviews = useRef(new Map<number, string[]>());
  useEffect(() => {
    for (const [id, urls] of sentPreviews.current) {
      if (messages.some((m) => m.id === id)) continue;
      for (const url of urls) URL.revokeObjectURL(url);
      sentPreviews.current.delete(id);
    }
  }, [messages]);
  useEffect(
    () => () => {
      for (const urls of sentPreviews.current.values()) for (const url of urls) URL.revokeObjectURL(url);
      sentPreviews.current.clear();
    },
    [],
  );
  // "preparing" (voice being made, no sound yet) is shown apart from "playing" (sound coming out).
  const speechPhase = useSyncExternalStore(subscribeSpeaking, getSpeechPhase, () => "idle" as const);
  const paused = speechPhase === "paused";

  const visible = useMemo(
    () => visibleMessages(messages, prefs.compactChat),
    [messages, prefs.compactChat],
  );
  // Reading replies aloud: the speak floor, what was spoken, failures and retry (components/chat/use-reply-speech.ts).
  const { speechFailures, setSpeechFailures, retrySpeech, primeFromSnapshot, historyPrimed, sessionKeyRef } = useReplySpeech({
    visible,
    messages,
    speakOn,
    connected,
    approval,
    question,
  });
  // Messages waiting in the outbox show after the thread, with Cancel.
  const threadMessages = useMemo(() => {
    const tagged = steeredTexts.current.size
      ? visible.map((m) => (m.role === "user" && !m.steered && steeredTexts.current.has(m.content.trim()) ? { ...m, steered: true } : m))
      : visible;
    return outbox.bubbles.length ? [...tagged, ...outbox.bubbles] : tagged;
  }, [visible, outbox.bubbles]);
  const awaiting = computeThinkingChrome({
    connected,
    pendingReply,
    busy,
    generating,
    approval: !!approval,
    // Thinking must see the full transcript, not the Compact-filtered list
    messages: messages.filter(
      (m) => m.role === "user" || m.role === "assistant" || m.role === "tool" || m.role === "system",
    ),
  });

  awaitingRef.current = awaiting;

  useEffect(() => {
    if (micStatus.state === "recording" || micStatus.state === "transcribing") setVoiceHint("");
  }, [micStatus.state]);

  useEffect(() => {
    let alive = true;
    let base = "";
    // When VoiceStudio (or another plugin engine) failed and Edge spoke instead, say so for 10 minutes.
    let fallbackUntil = 0;
    let clear = 0;
    const show = () => {
      if (!alive || !base) return;
      const fallback = Date.now() < fallbackUntil;
      // The header says "Online" when voice is fine; which engines speak and listen is in Settings → Voice.
      setVoiceLabel(fallback ? "Online \u00b7 speaking with the backup voice" : "");
      window.clearTimeout(clear);
      if (fallback) clear = window.setTimeout(show, fallbackUntil - Date.now() + 50);
    };
    const load = () => {
      fetchVoiceConfig()
        .then((cfg) => {
          if (!alive) return;
          if (cfg.missing) {
            base = "";
            setVoiceLabel("Voice not loaded — relaunch Chief Command Center");
            return;
          }
          const stt = cfg.stt?.provider || "local";
          const tts = cfg.tts?.provider || "edge";
          base = `Voice \u00b7 ${stt} / ${tts}`;
          const at = cfg.tts?.fallback?.at;
          if (at) fallbackUntil = Math.max(fallbackUntil, at * 1000 + 600_000);
          show();
        })
        .catch(() => {
          if (alive) setVoiceLabel("");
        });
    };
    const onFallback = () => {
      fallbackUntil = Date.now() + 600_000;
      show();
    };
    load();
    window.addEventListener(VOICE_EVENT, load);
    window.addEventListener(VOICE_FALLBACK_EVENT, onFallback);
    return () => {
      alive = false;
      window.clearTimeout(clear);
      window.removeEventListener(VOICE_EVENT, load);
      window.removeEventListener(VOICE_FALLBACK_EVENT, onFallback);
    };
  }, []);

  useEffect(() => {
    onThinkingChange?.(awaiting);
  }, [awaiting, onThinkingChange]);
  useEffect(() => {
    if (shouldClearPendingReply({ pendingReply, messages, generating, busy })) {
      setPendingReply(false);
    }
  }, [messages, pendingReply, generating, busy]);


  useEffect(() => {
    return () => onThinkingChange?.(false);
  }, [onThinkingChange]);


  const applyTranscript = useCallback(
    (data: Transcript, after: number) => {
      setGenerating(!!data.generating);
      if (historyPrimed.current && data.sessionKey !== sessionKeyRef.current) {
        historyPrimed.current = false;
        lastIdRef.current = 0;
        setMessages([]);
        setNotices([]);
        noticeSince.current = 0;
        setEarlier({ more: true, loading: false, error: "" });
        earlierCursor.current = null;
        stopSpeech();
        if (after) return;
      }
      const canPrime = !!(data.sessionKey || (data.messages || []).length);
      if (!historyPrimed.current) {
        if (after) {
          lastIdRef.current = 0;
          return;
        }
        if (!canPrime) return;
        lastIdRef.current = data.lastId || 0;
        setMessages(data.messages || []);
        if (typeof data.more === "boolean") setEarlier((e) => ({ ...e, more: !!data.more }));
        primeFromSnapshot(data);
        return;
      }
      lastIdRef.current = data.lastId || after;
      if (!after) {
        setMessages(data.messages || []);
        if (typeof data.more === "boolean") setEarlier((e) => ({ ...e, more: !!data.more }));
        if (data.sessionKey && data.sessionKey !== sessionKeyRef.current) primeFromSnapshot(data);
        return;
      }
      if (data.messages?.length) {
        setMessages((prev) => mergeMsgs(prev, data.messages));
        const replays = data.messages.filter((m) => m.replay).length;
        if (replays) {
          // Hermes compacted the chief's context and re-sent the conversation it kept. Not new: not shown or spoken.
          logSpeech({
            at: Date.now(),
            preview: "Context compaction",
            parts: 0,
            outcome: "skipped",
            reason: `${replays} earlier ${replays === 1 ? "message was" : "messages were"} re-sent after compaction; not shown or read again`,
            hidden: document.visibilityState === "hidden",
            metered: false,
          });
        }
        if (data.messages.some((m) => !m.replay && m.role === "assistant" && chatTone(m) === "reply" && (m.content || "").trim())) fx("reply");
      }
    },
    [primeFromSnapshot, historyPrimed, sessionKeyRef],
  );

  useEffect(() => poll(async signal => {
    const after = historyPrimed.current ? lastIdRef.current || 0 : 0;
    // What the bridge last told us, not local guesses: a difference would return the long-poll at once.
    const state = bridgeState.current;
    const live = longpollRef.current && historyPrimed.current
      ? { wait: 25, gen: state.generating, approval: state.approval, clarify: state.clarify, notice: state.notice, bg: state.bg }
      : undefined;
    const started = Date.now();
    // An open long-poll is the chat connected and waiting for news, not a chat gone quiet.
    if (live) transcriptHealth.pending();
    try {
      const data = await fetchTranscript(after, signal, live, after ? noticeSince.current : 0);
      if (signal.aborted) return;
      applyTranscript(data, after);
      setLoadedOnce(true);
      bridgeState.current = {
        generating: !!data.generating,
        approval: data.approval?.requestId || "",
        clarify: data.clarify?.id || "",
        notice: data.noticeHead || "",
        // Only a bridge that reports background work is asked to wake on it.
        ...(typeof data.backgroundSig === "string" ? { bg: data.backgroundSig } : {}),
      };
      setBackground(Array.isArray(data.background) ? data.background : []);
      if ("clarify" in data) setQuestion(data.clarify ?? null);
      if (Array.isArray(data.previous)) setPrevious(data.previous);
      setActivity(data.activity ?? null);
      if (Array.isArray(data.notices)) {
        const fresh = data.notices;
        setNotices((prev) => {
          const base = after ? prev : [];
          const have = new Set(base.map((n) => n.id));
          const next = [...base, ...fresh.filter((n) => !have.has(n.id))].sort((a, b) => a.at - b.at);
          noticeSince.current = next.length ? next[next.length - 1].at : noticeSince.current;
          return next.length === base.length && after ? prev : next;
        });
      }
      if ("approval" in data) approvalUpdate.current?.(data.approval ?? null);
      if (data.longpoll && !longpollRef.current) {
        longpollRef.current = true;
        setLongpoll(true);
      }
      // A long-poll that keeps coming straight back (a bridge that can't hold) must not spin.
      quickReturns.current = live && Date.now() - started < 300 && !data.messages.length ? quickReturns.current + 1 : 0;
      transcriptHealth.success();
      failStreak.current = 0;
    } catch (error) {
      if (!signal.aborted) {
        transcriptHealth.failure(error);
        failStreak.current += 1;
      }
    }
    // After a failure, wait before the next try (1 s, 2 s, 4 s … 10 s): two tries 150 ms apart fail for the same
    // reason, and "two failures in a row" (a real error) needs them to be separate.
  }, () => (failStreak.current ? Math.min(1000 * 2 ** (failStreak.current - 1), 10_000) : longpollRef.current ? (quickReturns.current > 3 ? 2500 : 150) : awaitingRef.current ? 800 : 2500)), [applyTranscript, transcriptHealth, historyPrimed]);

  // Load earlier: pages of older rows before the oldest one shown.
  // Where the next page starts: the bridge's cursor, so rows skipped here are never asked for again.
  const earlierCursor = useRef<number | null>(null);
  const loadEarlier = useCallback(async () => {
    const oldest = messages.reduce((n, m) => (m.id > 0 && m.id < 1e12 ? Math.min(n, m.id) : n), Number.POSITIVE_INFINITY);
    if (!Number.isFinite(oldest)) return;
    let before = Math.min(oldest, earlierCursor.current ?? oldest);
    // Earlier pages include the conversation archived at the chief's last compaction; the thread already
    // shows its kept tail as the copies Hermes re-inserted (flagged replay), so skip their originals.
    const copies = new Set(messages.filter(m => m.replay).map(m => `${m.role}|${sameText(m.content || "")}`));
    const have = new Set(messages.map(m => m.id));
    setEarlier(e => ({ ...e, loading: true, error: "" }));
    try {
      let found: ChatMessage[] = [];
      let more = true;
      // A page can be all tool calls or copies: read on (a few pages) until something shows.
      for (let page = 0; page < 3 && more && !found.length; page++) {
        const data = await fetchEarlier(before);
        found = data.messages.filter(m => !have.has(m.id) && !m.replay && m.id < oldest && !copies.has(`${m.role}|${sameText(m.content || "")}`));
        more = !!data.more;
        before = typeof data.cursor === "number" ? Math.min(before, data.cursor) : before;
      }
      earlierCursor.current = before;
      if (found.length) setMessages(prev => [...found.filter(m => !prev.some(p => p.id === m.id)), ...prev]);
      setEarlier({ more, loading: false, error: "" });
    } catch (error) {
      setEarlier(e => ({ ...e, loading: false, error: error instanceof Error ? error.message : "Couldn't load earlier messages" }));
    }
  }, [messages]);

  useEffect(() => {
    if (!pendingReply || generating || busy) return;
    const timer = window.setTimeout(() => setPendingReply(false), 21_000);
    return () => window.clearTimeout(timer);
  }, [pendingReply, generating, busy]);



  function addFiles(list: FileList | null) {
    const picked = Array.from(list || []);
    if (!picked.length) return;
    setSendError("");
    // Photos are shrunk on this device first (lib/image-shrink.ts) unless Settings says full size.
    void Promise.all(picked.map(file => (fullPhotosOn() ? file : shrinkImage(file)))).then(admit);
  }

  function admit(incoming: File[]) {
    setPendingFiles(current => {
      const next = [...current];
      const { accepted, error } = admitFiles(current.map(item => ({ name: item.name, size: item.file.size })), incoming);
      if (error) setSendError(error);
      for (const file of accepted) {
        const mime = file.type || "application/octet-stream";
        next.push({
          id: `${file.name}-${file.size}-${file.lastModified}-${next.length}`,
          name: file.name || "file",
          mime,
          previewUrl: URL.createObjectURL(file),
          file,
        });
      }
      return next;
    });
  }

  function removeFile(id: string) {
    setPendingFiles(current => {
      const target = current.find(item => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter(item => item.id !== id);
    });
  }

  async function sendBody(body: string, files: PendingFile[] = pendingFiles): Promise<void> {
    const trimmed = body.trim();
    if (!trimmed && !files.length) throw new Error("Message is empty.");
    if (busyRef.current) throw new Error("A message is still sending. Try again when it finishes.");
    if (authFailed) throw new Error(`${assistantName()} is unavailable. Your message has been kept.`);
    // While the chief waits on its question, what you type is the answer (shown as the question and its
    // answer, not as a new message).
    const open = questionRef.current;
    if (open && connected && !files.length && trimmed) {
      busyRef.current = true;
      setBusy(true);
      setSendError("");
      try {
        await answerOpenQuestion(open.id, trimmed);
        showNotice(`Answer sent to ${assistantName()}.`);
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
      return;
    }
    // A gateway command ("/new", "/approve"): Hermes answers it with a notice and never stores it as a
    // message, so it gets no bubble that would wait forever for its stored copy.
    if (connected && !files.length && /^\/[a-z][\w-]*(\s|$)/i.test(trimmed)) {
      busyRef.current = true;
      setBusy(true);
      setSendError("");
      try {
        const result = await sendToChief(trimmed, [], newSendId());
        if (!result.ok) throw new Error(result.error || `${assistantName()} did not accept the command.`);
        showNotice(`Sent ${trimmed.split(/\s/)[0]}.`);
        fx("send");
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
      return;
    }
    if (!connected) {
      // The chief is unreachable: the message waits in the outbox and goes when it is back.
      await outbox.enqueue(newSendId(), trimmed, files.map(file => ({ name: file.name, mime: file.mime, blob: file.file })));
      releasePending(files);
      setSendError("");
      showNotice(`${assistantName()} is offline. Your message will go once they're back.`);
      fx("send");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setPendingReply(true);
    setSendError("");
    setSendNotice("");
    const localAttachments: ChatAttachment[] = files.map(file => ({
      path: file.previewUrl || file.name,
      name: file.name,
      kind: file.mime.startsWith("image/") ? "image" : file.mime.startsWith("video/") ? "video" : file.mime.startsWith("audio/") ? "audio" : "file",
      mime: file.mime,
    }));
    // Sent while the chief works: it is added to that work (steer mode), not a new turn.
    const steered = generatingRef.current && !files.length;
    if (steered) steeredTexts.current.add(trimmed);
    const optimistic: ChatMessage = {
      id: Date.now(),
      role: "user",
      content: trimmed,
      timestamp: new Date().toISOString(),
      attachments: localAttachments.filter(item => item.path || item.name),
      ...(steered ? { steered: true } : {}),
    };
    setMessages(m => [...m, optimistic]);
    // Retrying the same draft reuses its id, so a send that timed out after the chief got it is not doubled.
    const signature = JSON.stringify([trimmed, files.map(file => file.id)]);
    if (retrySend.current?.signature !== signature) retrySend.current = { signature, id: newSendId() };
    const clientId = retrySend.current.id;
    try {
      const attachments: OutboundAttachment[] = await Promise.all(files.map(async file => ({
        name: file.name,
        mime: file.mime,
        data_url: await blobToDataUrl(file.file),
      })));
      const result = await sendToChief(trimmed, attachments, clientId);
      // Accepted by the bridge but refused: not something a retry fixes.
      if (!result.ok) throw Object.assign(new Error(result.error || `${assistantName()} did not accept the message.`), { status: 422 });
      retrySend.current = null;
      setPendingFiles(current => current.filter(item => !files.some(file => file.id === item.id)));
      const previews = files.map(file => file.previewUrl).filter((url): url is string => !!url);
      if (previews.length) sentPreviews.current.set(optimistic.id, previews);
      // The chief has it; the bubble stays until the transcript brings the stored copy.
      setMessages(m => m.map(item => (item === optimistic ? { ...item, delivery: "sent" } : item)));
      showNotice(steered ? `Added to what ${assistantName()} is doing.` : `Sent to ${assistantName()}.`);
      fx("send");
    } catch (error) {
      setPendingReply(false);
      setMessages(m => m.filter(item => item !== optimistic));
      if (retryable(error)) {
        // The network or the gateway, not the message: queue it under the same id, so if it did reach
        // The chief before the failure the bridge drops the repeat.
        retrySend.current = null;
        const reason = error instanceof Error ? error.message : `${assistantName()} is unreachable`;
        await outbox.enqueue(clientId, trimmed, files.map(file => ({ name: file.name, mime: file.mime, blob: file.file })), reason);
        releasePending(files);
        showNotice(`Couldn't reach ${assistantName()}. Queued; it will retry on its own.`);
        return;
      }
      const detail = error instanceof Error ? error.message : "Send failed.";
      setSendError(`${detail} Your draft has been kept.`);
      fx("error");
      throw error;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  function showNotice(text: string) {
    setSendNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setSendNotice(""), 4000);
  }

  /** Stop the chief's current turn (Hermes's /stop). The partial reply stays in the thread. */
  async function stopWork() {
    if (stopping) return;
    setStopping(true);
    try {
      const res = await stopTurn();
      if (!res.ok) throw new Error(res.error || "Couldn't stop.");
      setPendingReply(false);
      showNotice(`Stopped ${assistantName()}.`);
      fx("send");
    } catch (error) {
      setSendError(error instanceof Error ? `${error.message}` : "Couldn't stop.");
      fx("error");
    } finally {
      setStopping(false);
    }
  }

  /** "Send after": the draft waits as a chip and goes, in order, once the chief finishes. */
  function sendAfter() {
    const body = draft.get().trim();
    if (!body) return;
    setAfterQueue((q) => [...q, { id: newSendId(), text: body }]);
    setText("");
    showNotice(`Will send when ${assistantName()} finishes.`);
  }

  /** Files now owned by the outbox leave the composer (their composer previews are released). */
  function releasePending(files: PendingFile[]) {
    setPendingFiles(current => current.filter(item => !files.some(file => file.id === item.id)));
    for (const file of files) if (file.previewUrl) URL.revokeObjectURL(file.previewUrl);
  }
  // Send-after chips go one at a time, each when the chief is idle again (the send itself makes it busy).
  useEffect(() => {
    if (!afterQueue.length || generating || busy || !connected || authFailed) return;
    const timer = setTimeout(() => {
      if (generatingRef.current || busyRef.current) return;
      const [next, ...rest] = afterQueue;
      setAfterQueue(rest);
      void sendBody(next.text, []).catch(() => setAfterQueue((q) => [next, ...q]));
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [afterQueue, generating, busy, connected, authFailed]);

  const sendRef = useRef<ChatSend>(sendBody);
  sendRef.current = sendBody;
  useEffect(() => {
    onSendReady?.(body => sendRef.current(body));
    return () => onSendReady?.(null);
  }, [onSendReady]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body = draft.get().trim();
    if (!body && !pendingFiles.length) return;
    try { await sendBody(body, pendingFiles); setText(""); } catch (error) { setSendError(error instanceof Error ? error.message : "Send failed. Your draft has been kept."); }
  }

  function chooseApproval(choice: ApprovalChoice) {
    if (!approval || resolvingRef.current) return;
    const requestId = approval.requestId;
    resolvingRef.current = true;
    setResolving(true);
    setApprovalError("");
    void resolveApproval(requestId, choice)
      .then((result) => {
        if (!result.ok || !result.resolved) throw new Error(result.error || "That approval is no longer pending. Wait for the next update.");
        if (choice === "always") fx("confirm");
        onApprovalResolved?.(requestId);
      })
      .catch((error) => {
        setApprovalError(error instanceof Error ? error.message : "Approval failed. Check its status before retrying.");
        fx("error");
      })
      .finally(() => {
        resolvingRef.current = false;
        setResolving(false);
      });
  }

  const answerOpenQuestion = useCallback(async (id: string, answer: string | string[]) => {
    const result = await answerQuestion(id, answer);
    if (!result.ok) {
      if (result.code === "gone") setQuestion(null);
      throw new Error(result.error || `${assistantName()} didn't get the answer.`);
    }
    setQuestion((q) => (q?.id === id ? null : q));
    fx("send");
  }, []);

  const mood: ChiefMood = approval || question
    ? "approval"
    : micStatus.state === "recording"
      ? "listening"
      : paused
        ? "paused"
        : speechPhase === "playing"
          ? "speaking"
          : speechPhase === "preparing"
            ? "preparing"
            : awaiting
            ? "thinking"
            : !connected || authFailed
              ? "offline"
              : "online";
  // Background work: the chat stays usable ("online"), but the face shows the chief is busy and the header says so.
  const backgroundTasks = backgroundTaskCount(background);
  const chiefFace = chief ? <ChiefPresence chief={chief} size={36} mood={backgroundTasks && mood === "online" ? "thinking" : mood} gazeRef={ref} /> : null;
  const followups = useFollowupWatch(messages, { primed: historyPrimed.current && messages.length > 0, busy: awaiting || busy });

  const onMicStatus = (next: MicStatus) => {
    const prev = micPrev.current;
    if (prev.state !== "recording" && next.state === "recording") fx("voice", "start");
    else if (prev.state === "recording" && next.state === "transcribing") fx("voice", "stop");
    else if (next.state === "recording" && next.cancelling !== prev.cancelling) fx("voice", "cancel");
    micPrev.current = next;
    setMicStatus(next);
  };
  const onTranscript = async (spoken: string) => {
    setVoiceHint("");
    setText(spoken);
    await sendBody(spoken);
    setText("");
  };
  const onMicStream = (stream: MediaStream | null) => {
    stopMicMeter.current?.();
    stopMicMeter.current = stream ? meterStream("mic", stream) : undefined;
  };
  const lastYou = voiceOpen ? lastText(visible, (m) => m.role === "user" && !isMachineNote(chatTone(m))) : "";
  const lastReply = voiceOpen ? lastText(visible, (m) => m.role === "assistant" && chatTone(m) === "reply") : "";

  // Files can be added while the chief is offline too: they wait in the outbox with the message.
  const canAttach = !authFailed && !busy;
  const draggingFiles = (e: React.DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");

  return (
    <div
      className="chief-chat relative flex h-full flex-col bg-pane"
      style={{ ["--chat-fs" as string]: `${fontPx}px` }}
      onDragEnter={(e) => {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDropping(true);
      }}
      onDragOver={(e) => {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = canAttach ? "copy" : "none";
      }}
      onDragLeave={(e) => {
        if (!draggingFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDropping(false);
      }}
      onDrop={(e) => {
        if (!draggingFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        if (canAttach) addFiles(e.dataTransfer.files);
      }}
    >
      {dropping ? (
        <div className="pointer-events-none absolute inset-2 z-50 grid place-items-center rounded-card border-2 border-dashed border-accent/60 bg-canvas/80 backdrop-blur-xs">
          <p className="flex items-center gap-2 text-headline text-fg">
            <PaperclipIcon size={20} className="text-accent-text" />
            {canAttach ? `Drop files for ${assistant}` : `${assistant} can't take files right now`}
          </p>
        </div>
      ) : null}
      <ChatHeader
        chief={chief}
        mood={mood}
        status={
          question && !approval
            ? { text: "Has a question for you", tone: "text-warn" }
            : backgroundTasks && mood === "online"
              ? { text: `Working in the background · ${backgroundTasks} task${backgroundTasks === 1 ? "" : "s"}`, tone: "text-fg-2" }
              : null
        }
        voiceLabel={voiceLabel}
        connected={connected}
        authFailed={authFailed}
        compact={compact}
        onPauseToggle={() => toggleSpeechPause()}
        onStop={() => {
          stopSpeech();
          setSpeechFailures([]);
        }}
        onOpenStatus={onOpenStatus}
        onOpenSettings={onOpenSettings}
        switcher={threadSwitcher}
        onVoiceMode={() => setVoiceOpen(true)}
        face={chiefFace}
      />
      <ChatAurora mood={mood} color={chief ? chiefColor(chief) : undefined} />
      <Thread
        messages={threadMessages}
        loading={!loadedOnce && connected && !authFailed}
        onCancelQueued={cancelQueued}
        onRetryQueued={outbox.retryNow}
        earlier={messages.length ? earlier : undefined}
        onLoadEarlier={loadEarlier}
        chief={chief}
        awaiting={awaiting}
        waitingApproval={!!approval}
        connected={connected}
        authFailed={authFailed}
        onSuggestion={(s) => setText(s)}
        notices={notices}
        activity={activity}
        question={question}
        onAnswer={answerOpenQuestion}
        onQuickReply={sendBody}
        header={previous.length ? <PreviousConversations items={previous} chief={chief} phone={!!compact} /> : null}
      />
      <form onSubmit={onSubmit} className="shrink-0">
        {backgroundTasks ? (
          <div className="px-4">
            <BackgroundWork units={background} assistant={assistant} color={chief ? chiefColor(chief) : undefined} />
          </div>
        ) : null}
        <div className="px-4 pb-2 empty:hidden">
          <FollowupCards
            items={followups}
            people={people}
            chief={chief}
            disabled={!connected || !!authFailed || busy}
            onAsk={(item) => sendBody(followupAsk(item))}
          />
        </div>
        <div className="space-y-1.5 px-4 empty:hidden">
          {sendError ? (
            <p role="alert" className="text-callout text-danger">
              {sendError}
            </p>
          ) : null}
          {sendNotice ? (
            <p role="status" className="flex items-center gap-1.5 text-caption text-fg-3">
              <CheckIcon size={13} className="text-ok" />
              {sendNotice}
            </p>
          ) : null}
          {voiceHint ? <p className="text-callout text-accent-text">{voiceHint}</p> : null}
          {micStatus.state === "transcribing" ? <p className="shimmer-text text-callout font-medium">Transcribing…</p> : null}
          {speechFailures.length ? (
            <div role="alert" className="flex flex-wrap items-center gap-x-2 text-callout text-warn">
              {speechFailures.every(item => item.held) ? (
                <span>
                  {speechFailures.length} earlier {speechFailures.length === 1 ? "reply wasn't" : "replies weren't"} read aloud.
                </span>
              ) : speechFailures.every(item => item.missed || item.held) ? (
                <span>
                  Missed {speechFailures.length} {speechFailures.length === 1 ? "reply" : "replies"} while you were away.
                </span>
              ) : (
                <span>
                  Could not speak {speechFailures.length} {speechFailures.length === 1 ? "reply" : "replies"}. {speechFailureReason(speechFailures)}
                </span>
              )}
              <button type="button" className="min-h-11 font-medium underline" onClick={retrySpeech}>
                {speechFailures.every(item => item.missed || item.held) ? "Play" : "Retry speech"}
              </button>
            </div>
          ) : null}
        </div>
        <ApprovalSheet
          approval={approval}
          minimized={approvalMin}
          resolving={resolving}
          error={approvalError}
          onMinimize={() => setApprovalMin(true)}
          onExpand={() => setApprovalMin(false)}
          onChoose={chooseApproval}
        />
        {afterQueue.length ? (
          <ul className="flex flex-col gap-1.5 px-4 pb-2" aria-label={`Waiting to send when ${assistantName()} finishes`}>
            {afterQueue.map((item) => (
              <li key={item.id} className="flex items-center gap-2 rounded-card border border-line-2 bg-card px-3 py-2">
                <span className="shrink-0 text-caption text-fg-3">After {assistantName()} finishes:</span>
                <span className="min-w-0 flex-1 truncate text-callout text-fg">{item.text}</span>
                {generating ? (
                  <button
                    type="button"
                    className="press min-h-9 shrink-0 rounded-full px-2.5 text-caption font-medium text-fg-2 hover:text-fg"
                    onClick={() => {
                      setAfterQueue((q) => q.filter((x) => x.id !== item.id));
                      void sendBody(item.text, []).catch(() => setAfterQueue((q) => [item, ...q]));
                    }}
                  >
                    Add now
                  </button>
                ) : null}
                <button
                  type="button"
                  aria-label={`Remove: ${item.text}`}
                  className="press grid size-9 shrink-0 place-items-center rounded-full text-fg-3 hover:text-fg"
                  onClick={() => setAfterQueue((q) => q.filter((x) => x.id !== item.id))}
                >
                  <XIcon size={15} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <DraftComposer
          draft={draft}
          pendingFiles={pendingFiles}
          onAddFiles={addFiles}
          onRemoveFile={removeFile}
          connected={connected && !authFailed}
          offline={!connected && !authFailed}
          busy={busy}
          micStatus={micStatus}
          onMicStatus={onMicStatus}
          onTranscript={onTranscript}
          onMicError={setVoiceHint}
          onMicStream={onMicStream}
          phone={!!compact}
          working={generating && connected && !authFailed}
          answering={!!question && connected && !authFailed}
          onStop={stopping ? undefined : () => void stopWork()}
          onSendAfter={sendAfter}
        />
      </form>
      {voiceMounted ? <VoiceMode
        open={voiceOpen}
        onClose={() => setVoiceOpen(false)}
        chief={chief}
        mood={mood}
        micStatus={micStatus}
        connected={connected && !authFailed}
        busy={busy}
        lastYou={lastYou}
        lastReply={lastReply}
        speakOn={speakOn}
        hint={voiceHint}
        onEnableSpeech={() => prefs.setSpeak(true)}
        onPauseToggle={() => toggleSpeechPause()}
        onStop={() => {
          stopSpeech();
          setSpeechFailures([]);
        }}
        onMicStatus={onMicStatus}
        onTranscript={onTranscript}
        onMicError={setVoiceHint}
        onMicStream={onMicStream}
      /> : null}
    </div>
  );
}

/** Plain text of the newest message matching `pick`, for voice mode's captions. */
function lastText(list: ChatMessage[], pick: (m: ChatMessage) => boolean) {
  for (let i = list.length - 1; i >= 0; i--) {
    if (!pick(list[i])) continue;
    const text = (list[i].content || "")
      .replace(/MEDIA:\s*.+?(?=\s+MEDIA:|$)/gi, "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/[*_`#>]+/g, "")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text;
  }
  return "";
}

function newSendId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* insecure context */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** An all-day session keeps growing; the oldest rows go once the chat holds this many. */
export const MAX_KEPT_MESSAGES = 600;


/**
 * New rows after the ones we have; each user row that arrived replaces one "Sending…" bubble.
 * The stored text can differ from what was typed (whitespace, inlined file notes, attachment-only
 * sends), so match loosely, oldest bubble first, rather than leave a bubble stuck forever.
 */
export function mergeMsgs(prev: ChatMessage[], incoming: ChatMessage[]) {
  const stable = prev.filter((m) => m.id < 1e12);
  let optimistic = prev.filter((m) => m.id >= 1e12);
  const seen = new Set(stable.map((m) => m.id));
  // Compaction copies are history the thread already shows (lib/replay-guard.ts).
  const extra = dropReplays(stable, incoming).filter((m) => !seen.has(m.id));
  const merged = extra.length ? [...stable, ...extra] : stable;
  for (const row of extra) {
    if (row.role !== "user" || !optimistic.length) continue;
    const body = sameText(row.content || "");
    let at = optimistic.findIndex((o) => sameText(o.content || "") === body);
    if (at < 0 && body) at = optimistic.findIndex((o) => !!sameText(o.content || "") && body.includes(sameText(o.content || "")));
    if (at < 0 && row.attachments?.length) at = optimistic.findIndex((o) => !!o.attachments?.length && !sameText(o.content || ""));
    if (at >= 0) optimistic = optimistic.filter((_, i) => i !== at);
  }
  const kept = merged.length > MAX_KEPT_MESSAGES ? merged.slice(merged.length - MAX_KEPT_MESSAGES) : merged;
  return [...kept, ...optimistic];
}

/** The message box, subscribed to the draft (the rest of the chat isn't). */
function DraftComposer({ draft, ...rest }: Omit<ComponentProps<typeof Composer>, "text" | "onText"> & { draft: DraftStore }) {
  const text = useDraft(draft);
  return <Composer text={text} onText={draft.set} {...rest} />;
}

/** Ambient aurora behind the top of the thread (§4.4): CSS only, brighter while the chief thinks or speaks. */
function ChatAurora({ mood, color }: { mood: ChiefMood; color?: string }) {
  return (
    <div aria-hidden className="chat-aurora" data-mood={mood} style={color ? ({ ["--chief" as string]: color } as CSSProperties) : undefined}>
      <span className="au-a" />
      <span className="au-b" />
    </div>
  );
}
